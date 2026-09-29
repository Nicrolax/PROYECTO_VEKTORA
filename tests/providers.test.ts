/**
 * Onboarding de proveedores y catálogo vivo de skills.
 *
 * Lo que se protege aquí es la propiedad de la que depende todo el matching de la FASE 4:
 * que `provider_skills` y `project_tasks.required_skills` hablen el MISMO vocabulario. Si
 * la resolución deja de colapsar `React 18`, `reactjs` y `react` en una sola skill, el
 * motor devolverá listas vacías sin que nada falle visiblemente.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingService } from '@/lib/ai/embeddings';
import { ProviderError, ProviderOnboarding } from '@/lib/providers/provider';
import { renderProviderForEmbedding } from '@/lib/providers/provider';
import type {
  PersonProfilePayload,
  ProviderProfilePayload,
  ProviderRepository,
  ProviderSkillLink,
  ResolvedSkill,
  SkillRecord,
  UserRecord,
} from '@/lib/providers/repository';
import { normalizeSkillSlug, RegisterProviderSchema } from '@/lib/providers/schemas';
import { describeResolution, resolveThreshold, SkillResolver } from '@/lib/providers/skills';

// ---------------------------------------------------------------------------------------
// Dobles de prueba
// ---------------------------------------------------------------------------------------

const CATALOG: SkillRecord[] = [
  { id: 'sk-react', slug: 'react', name: 'React', category: 'engineering' },
  { id: 'sk-next', slug: 'nextjs', name: 'Next.js', category: 'engineering' },
  { id: 'sk-ts', slug: 'typescript', name: 'TypeScript', category: 'engineering' },
];

class FakeRepository implements ProviderRepository {
  readonly personProfiles: Array<[string, PersonProfilePayload]> = [];
  readonly providerProfiles: Array<[string, ProviderProfilePayload]> = [];
  readonly linkedSkills: ProviderSkillLink[] = [];
  readonly savedEmbeddings: Array<{ id: string; vector: string; model: string }> = [];
  readonly resolveCalls: Array<{ slug: string; vector?: string | undefined }> = [];

  constructor(
    private readonly users: UserRecord[] = [
      { id: 'u-1', email: 'proveedora@ejemplo.com', status: 'active' },
    ],
    // Copia propia: `resolveOrCreateSkill` añade filas, y compartir el array entre
    // instancias haría que una prueba contaminara a la siguiente.
    private readonly catalog: SkillRecord[] = CATALOG.map((skill) => ({ ...skill })),
    private readonly aliases: Record<string, string> = { 'react-18': 'sk-react' },
    /** slug propuesto -> skill a la que lo mapea el paso semántico. */
    // 0.97 está por encima del umbral por defecto (0.95, medido con skills:calibrate) y
    // por debajo de 1: es el rango donde de verdad vive un sinónimo ortográfico.
    private readonly semantic: Record<string, { skillId: string; similarity: number }> = {
      reactjs: { skillId: 'sk-react', similarity: 0.97 },
    },
  ) {}

  async findUserById(userId: string): Promise<UserRecord | null> {
    return this.users.find((user) => user.id === userId) ?? null;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.users.find((user) => user.email === email) ?? null;
  }

  async findSkillsBySlugs(slugs: readonly string[]): Promise<SkillRecord[]> {
    return this.catalog.filter((skill) => slugs.includes(skill.slug));
  }

  async findSkillsByAliases(aliases: readonly string[]): Promise<Map<string, SkillRecord>> {
    const out = new Map<string, SkillRecord>();
    for (const alias of aliases) {
      const skillId = this.aliases[alias];
      const skill = this.catalog.find((entry) => entry.id === skillId);
      if (skill !== undefined) out.set(alias, skill);
    }
    return out;
  }

  async resolveOrCreateSkill(params: {
    slug: string;
    name?: string | undefined;
    vector?: string | undefined;
    threshold: number;
  }): Promise<Omit<ResolvedSkill, 'proposed'>> {
    this.resolveCalls.push({ slug: params.slug, vector: params.vector });

    const hit = this.semantic[params.slug];
    if (params.vector !== undefined && hit !== undefined && hit.similarity >= params.threshold) {
      const skill = this.catalog.find((entry) => entry.id === hit.skillId);
      if (skill !== undefined) {
        return {
          skillId: skill.id,
          slug: skill.slug,
          name: skill.name,
          category: skill.category,
          match: 'semantic',
          similarity: hit.similarity,
        };
      }
    }

    const created: SkillRecord = {
      id: `sk-${params.slug}`,
      slug: params.slug,
      name: params.name ?? params.slug,
      category: 'auto',
    };
    this.catalog.push(created);
    return { ...created, skillId: created.id, match: 'created', similarity: null };
  }

  async upsertPersonProfile(userId: string, payload: PersonProfilePayload): Promise<void> {
    this.personProfiles.push([userId, payload]);
  }

  async upsertProviderProfile(userId: string, payload: ProviderProfilePayload): Promise<string> {
    this.providerProfiles.push([userId, payload]);
    return 'pp-1';
  }

  async setProviderSkills(_id: string, links: readonly ProviderSkillLink[]): Promise<number> {
    this.linkedSkills.length = 0;
    this.linkedSkills.push(...links);
    return links.length;
  }

  async saveProviderEmbedding(id: string, vector: string, model: string): Promise<boolean> {
    this.savedEmbeddings.push({ id, vector, model });
    return true;
  }
}

function fakeEmbeddings(dimensions = 4): EmbeddingService {
  return {
    dimensions,
    defaultTaskType: 'RETRIEVAL_DOCUMENT',
    isAvailable: () => true,
    describeModel: () => 'fake',
    async embedTexts({ texts }: { texts: string[] }) {
      return {
        vectors: texts.map((_, index) =>
          Array.from({ length: dimensions }, (_, i) => (i + index + 1) / 10),
        ),
        model: 'gemini-embedding-001',
        dimensions,
        usage: {},
        costUsd: 0,
        latencyMs: 1,
        runId: null,
      };
    },
  } as unknown as EmbeddingService;
}

const validInput = {
  email: 'proveedora@ejemplo.com',
  provider: {
    headline: 'Ingeniera front-end especializada en Next.js',
    summary:
      'Ocho años construyendo interfaces de producto con React y Next.js, con foco en ' +
      'accesibilidad y rendimiento.',
  },
  skills: [{ slug: 'react' }],
};

// ---------------------------------------------------------------------------------------

describe('normalizeSkillSlug', () => {
  it('colapsa las variantes ortográficas al mismo slug', () => {
    for (const raw of ['React 18', 'react-18', '  REACT 18  ', 'react--18']) {
      expect(normalizeSkillSlug(raw)).toBe('react-18');
    }
  });

  it('quita separadores en los bordes y caracteres inválidos', () => {
    expect(normalizeSkillSlug('  Next.js  ')).toBe('next-js');
    expect(normalizeSkillSlug('C++')).toBe('c');
    expect(normalizeSkillSlug('---')).toBe('');
  });
});

describe('contrato de alta', () => {
  it('acepta un alta mínima válida', () => {
    expect(RegisterProviderSchema.safeParse(validInput).success).toBe(true);
  });

  it('exige userId o email', () => {
    const { email: _omitted, ...withoutAccount } = validInput;
    const result = RegisterProviderSchema.safeParse(withoutAccount);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.message.includes('userId o email'))).toBe(true);
  });

  it('rechaza dos skills que normalizan al mismo slug', () => {
    const result = RegisterProviderSchema.safeParse({
      ...validInput,
      skills: [{ slug: 'React 18' }, { slug: 'react-18' }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.message.includes('la misma skill'))).toBe(true);
  });

  it('rechaza un headline demasiado corto para producir un embedding útil', () => {
    const result = RegisterProviderSchema.safeParse({
      ...validInput,
      provider: { ...validInput.provider, headline: 'Dev' },
    });
    expect(result.success).toBe(false);
  });

  it('exige al menos una skill: sin skills no hay nada que emparejar', () => {
    expect(RegisterProviderSchema.safeParse({ ...validInput, skills: [] }).success).toBe(false);
  });

  it('aplica los valores por defecto de consentimiento', () => {
    const result = RegisterProviderSchema.parse(validInput);
    expect(result.provider.acceptsAutoAssign).toBe(true);
    expect(result.provider.isActive).toBe(true);
    expect(result.skills[0]?.level).toBe(3);
  });
});

describe('SkillResolver — cascada de resolución', () => {
  it('resuelve por slug exacto sin gastar embeddings', async () => {
    const repository = new FakeRepository();
    const resolver = new SkillResolver({ repository, embeddings: fakeEmbeddings() });
    const result = await resolver.resolve([{ slug: 'react' }, { slug: 'TypeScript' }]);

    expect(result.resolved.map((skill) => skill.match)).toEqual(['exact', 'exact']);
    expect(result.embedded).toBe(0);
    expect(repository.resolveCalls).toHaveLength(0);
  });

  it('resuelve por alias ya registrado, también gratis', async () => {
    const repository = new FakeRepository();
    const resolver = new SkillResolver({ repository, embeddings: fakeEmbeddings() });
    const result = await resolver.resolve([{ slug: 'React 18' }]);

    expect(result.resolved[0]?.match).toBe('alias');
    expect(result.resolved[0]?.slug).toBe('react');
    expect(result.embedded).toBe(0);
  });

  it('mapea semánticamente un slug desconocido y NO crea fila', async () => {
    const repository = new FakeRepository();
    const resolver = new SkillResolver({ repository, embeddings: fakeEmbeddings() });
    const result = await resolver.resolve([{ slug: 'reactjs' }]);

    expect(result.resolved[0]?.match).toBe('semantic');
    expect(result.resolved[0]?.slug).toBe('react');
    expect(result.resolved[0]?.similarity).toBeCloseTo(0.97, 5);
    expect(result.embedded).toBe(1);
  });

  it('crea la skill cuando nada se parece lo suficiente', async () => {
    const repository = new FakeRepository();
    const resolver = new SkillResolver({ repository, embeddings: fakeEmbeddings() });
    const result = await resolver.resolve([
      { slug: 'soldadura-tig', name: 'Soldadura TIG' },
    ]);

    expect(result.resolved[0]?.match).toBe('created');
    expect(result.resolved[0]?.slug).toBe('soldadura-tig');
  });

  it('solo gasta embeddings en los slugs desconocidos', async () => {
    const repository = new FakeRepository();
    const resolver = new SkillResolver({ repository, embeddings: fakeEmbeddings() });
    const result = await resolver.resolve([
      { slug: 'react' },        // exacta
      { slug: 'React 18' },     // alias
      { slug: 'reactjs' },      // semántica
      { slug: 'soldadura-tig' } // nueva
    ]);

    expect(result.resolved.map((skill) => skill.match)).toEqual([
      'exact',
      'alias',
      'semantic',
      'created',
    ]);
    // Cuatro declaradas, dos embeddings: es lo que hace viable esto en un free tier.
    expect(result.embedded).toBe(2);
  });

  // Regresión: la primera versión devolvía primero las coincidencias exactas y al final
  // las resueltas contra la base. `ProviderOnboarding` empareja por índice, así que el
  // nivel y los años de experiencia acababan colgados de la skill equivocada — sin que
  // nada fallara visiblemente.
  it('devuelve las resoluciones EN EL ORDEN DE ENTRADA', async () => {
    const repository = new FakeRepository();
    const resolver = new SkillResolver({ repository, embeddings: fakeEmbeddings() });
    const entrada = [
      { slug: 'soldadura-tig' }, // se crea
      { slug: 'react' },         // exacta
      { slug: 'reactjs' },       // semántica
      { slug: 'React 18' },      // alias
      { slug: 'typescript' },    // exacta
    ];
    const result = await resolver.resolve(entrada);

    expect(result.resolved.map((skill) => skill.proposed)).toEqual([
      'soldadura-tig',
      'react',
      'reactjs',
      'react-18',
      'typescript',
    ]);
    expect(result.resolved.map((skill) => skill.match)).toEqual([
      'created',
      'exact',
      'semantic',
      'alias',
      'exact',
    ]);
  });

  it('sin embeddings degrada a exacta + alias + creación, no falla', async () => {
    const repository = new FakeRepository();
    const resolver = new SkillResolver({ repository, embeddings: null });
    const result = await resolver.resolve([{ slug: 'react' }, { slug: 'reactjs' }]);

    expect(result.degraded).toBe(true);
    expect(result.embedded).toBe(0);
    expect(result.resolved[0]?.match).toBe('exact');
    // Sin vector, `reactjs` no puede mapearse a `react`: se crea.
    expect(result.resolved[1]?.match).toBe('created');
  });

  it('un fallo del proveedor de embeddings degrada en vez de abortar', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = {
      isAvailable: () => true,
      async embedTexts() {
        throw new Error('429 desde Google');
      },
    } as unknown as EmbeddingService;

    const repository = new FakeRepository();
    const resolver = new SkillResolver({ repository, embeddings: broken });
    const result = await resolver.resolve([{ slug: 'reactjs' }]);

    expect(result.degraded).toBe(true);
    expect(result.resolved).toHaveLength(1);
  });

  it('el umbral sale del parámetro, del entorno o de la constante, en ese orden', () => {
    expect(resolveThreshold(0.5)).toBe(0.5);
    expect(resolveThreshold()).toBe(0.95);
  });

  it('describeResolution explica cada decisión automática', () => {
    const descriptions = describeResolution([
      { proposed: 'reactjs', skillId: 'sk-react', slug: 'react', name: 'React', category: null, match: 'semantic', similarity: 0.97 },
      { proposed: 'x', skillId: 'sk-x', slug: 'x', name: 'X', category: 'auto', match: 'created', similarity: null },
    ]);
    expect(descriptions[0]).toContain('semántica, 0.970');
    expect(descriptions[1]).toContain('NUEVA');
  });
});

describe('ProviderOnboarding', () => {
  it('da de alta el perfil, vincula las skills y vectoriza', async () => {
    const repository = new FakeRepository();
    const onboarding = new ProviderOnboarding({ repository, embeddings: fakeEmbeddings() });

    const result = await onboarding.register({
      ...validInput,
      person: { fullName: 'Nombre Apellido', countryCode: 'uy' },
      skills: [{ slug: 'react', level: 5, yearsExperience: 8 }, { slug: 'nextjs', level: 4 }],
    });

    expect(result.userId).toBe('u-1');
    expect(result.providerProfileId).toBe('pp-1');
    expect(result.linkedSkills).toBe(2);
    expect(result.profileEmbedded).toBe(true);
    expect(repository.savedEmbeddings).toHaveLength(1);
    // El código de país se normaliza a mayúsculas: la columna es char(2) ISO.
    expect(repository.personProfiles[0]?.[1].country_code).toBe('UY');
  });

  it('dos declaraciones que resuelven a la MISMA skill conservan el nivel más alto', async () => {
    const repository = new FakeRepository();
    const onboarding = new ProviderOnboarding({ repository, embeddings: fakeEmbeddings() });

    await onboarding.register({
      ...validInput,
      skills: [
        { slug: 'react', level: 3, yearsExperience: 2 },
        { slug: 'reactjs', level: 5, yearsExperience: 8 },
      ],
    });

    // Rebajar la competencia de alguien por un detalle de ortografía sería un error.
    expect(repository.linkedSkills).toHaveLength(1);
    expect(repository.linkedSkills[0]).toMatchObject({
      skill_id: 'sk-react',
      level: 5,
      years_experience: 8,
    });
  });

  it('falla si la cuenta no existe en public.users', async () => {
    const repository = new FakeRepository([]);
    const onboarding = new ProviderOnboarding({ repository, embeddings: null });
    await expect(onboarding.register(validInput)).rejects.toThrowError(/no existe la cuenta/);
  });

  it('rechaza una cuenta suspendida', async () => {
    const repository = new FakeRepository([
      { id: 'u-1', email: 'proveedora@ejemplo.com', status: 'suspended' },
    ]);
    const onboarding = new ProviderOnboarding({ repository, embeddings: null });
    await expect(onboarding.register(validInput)).rejects.toThrowError(/suspended/);
  });

  it('propaga los errores de validación como ProviderError legible', async () => {
    const repository = new FakeRepository();
    const onboarding = new ProviderOnboarding({ repository, embeddings: null });
    await expect(
      onboarding.register({ ...validInput, skills: [] }),
    ).rejects.toThrowError(ProviderError);
  });

  it('si falla la vectorización el alta SIGUE siendo válida', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = new FakeRepository();
    const broken = {
      isAvailable: () => true,
      async embedTexts() {
        throw new Error('sin cuota');
      },
    } as unknown as EmbeddingService;

    const onboarding = new ProviderOnboarding({ repository, embeddings: broken });
    const result = await onboarding.register(validInput);

    expect(result.profileEmbedded).toBe(false);
    expect(result.linkedSkills).toBe(1);
    expect(repository.providerProfiles).toHaveLength(1);
  });

  it('embedProfile:false salta la vectorización', async () => {
    const repository = new FakeRepository();
    const onboarding = new ProviderOnboarding({ repository, embeddings: fakeEmbeddings() });
    const result = await onboarding.register({ ...validInput, embedProfile: false });
    expect(result.profileEmbedded).toBe(false);
    expect(repository.savedEmbeddings).toHaveLength(0);
  });

  it('el texto vectorizado incluye las skills RESUELTAS, no las declaradas', () => {
    const text = renderProviderForEmbedding(
      { headline: 'Front-end', summary: 'Resumen', seniority: 'senior' },
      [
        { proposed: 'reactjs', skillId: 'sk-react', slug: 'react', name: 'React', category: null, match: 'semantic', similarity: 0.9 },
      ],
    );
    // `react` es lo que aparece en project_tasks.required_skills: es contra eso que se compara.
    expect(text).toContain('Skills: react');
    expect(text).not.toContain('reactjs');
  });
});
