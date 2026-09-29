/**
 * Validación de entrada. Módulo puro.
 *
 * Lo que se protege aquí no es la forma de los datos —eso ya lo hace Zod— sino que lo que
 * llega tenga CONTENIDO. Cada proyecto creado cuesta una llamada a un modelo, y un objetivo
 * vacío no produce un plan malo: produce un plan inventado, porque el modelo rellena el
 * hueco. Eso se paga igual.
 */

import { describe, expect, it } from 'vitest';
import {
  diversidadDePalabras,
  diversidadLexica,
  validarCorreo,
  validarPresupuesto,
  validarTextoSustantivo,
} from '@/lib/validacion/entrada';

describe('validarCorreo', () => {
  it('acepta direcciones normales', () => {
    for (const correo of [
      'yazmin@utec.edu.uy',
      'nombre.apellido+etiqueta@gmail.com',
      'a@b.co',
      'UPPER@Example.Uy',
    ]) {
      expect(validarCorreo(correo).valido, correo).toBe(true);
    }
  });

  it('rechaza lo que no tiene forma de correo', () => {
    for (const correo of ['sinarroba', 'dos@@arrobas.com', '@sinusuario.com', 'usuario@', 'a@b']) {
      expect(validarCorreo(correo).valido, correo).toBe(false);
    }
  });

  it('rechaza espacios, dominios truncados y puntos dobles', () => {
    expect(validarCorreo('con espacio@dominio.com').valido).toBe(false);
    expect(validarCorreo('usuario@dominio..com').valido).toBe(false);
    expect(validarCorreo('usuario@.com').valido).toBe(false);
    expect(validarCorreo('usuario@dominio.').valido).toBe(false);
    expect(validarCorreo('usuario@dominio.c1').valido).toBe(false);
  });

  it('los desechables solo se bloquean si se pide', () => {
    expect(validarCorreo('x@mailinator.com').valido).toBe(true);
    const estricto = validarCorreo('x@mailinator.com', { bloquearDesechables: true });
    expect(estricto.valido).toBe(false);
    // El motivo explica POR QUÉ, no solo que está mal.
    expect(estricto.motivo).toContain('veredicto');
  });

  it('los dominios reservados para ejemplos se pueden bloquear aparte', () => {
    expect(validarCorreo('x@example.com', { bloquearReservados: true }).valido).toBe(false);
    expect(validarCorreo('x@example.com', { bloquearDesechables: true }).valido).toBe(true);
  });

  it('no se deja engañar por mayúsculas ni espacios alrededor', () => {
    expect(
      validarCorreo('  X@MAILINATOR.COM  ', { bloquearDesechables: true }).valido,
    ).toBe(false);
  });
});

describe('validarTextoSustantivo', () => {
  const bueno =
    'Necesito una guía de estilo de marca para una cafetería de especialidad, con paleta ' +
    'de colores, tipografía y uso del logotipo.';

  it('acepta un objetivo real', () => {
    expect(validarTextoSustantivo(bueno).valido).toBe(true);
  });

  it('rechaza el teclado aporreado aunque tenga longitud', () => {
    const resultado = validarTextoSustantivo('asdfasdfasdfasdfasdfasdfasdfasdfasdfasdf');
    expect(resultado.valido).toBe(false);
  });

  it('rechaza la misma palabra repetida', () => {
    const resultado = validarTextoSustantivo('proyecto proyecto proyecto proyecto proyecto proyecto proyecto');
    expect(resultado.valido).toBe(false);
    expect(resultado.motivo).toContain('repite');
  });

  it('rechaza un texto demasiado corto', () => {
    expect(validarTextoSustantivo('necesito ayuda').valido).toBe(false);
  });

  it('rechaza un carácter repetido muchas veces', () => {
    expect(
      validarTextoSustantivo('quiero una holaaaaaaaaaaaaa tienda de ropa online bonita').valido,
    ).toBe(false);
  });

  it('el mínimo de palabras es configurable', () => {
    expect(validarTextoSustantivo('quiero vender ropa', { minPalabras: 3, minPalabrasDistintas: 3 }).valido).toBe(true);
  });

  it('no penaliza un texto legítimo que repite un término clave', () => {
    // «marca» aparece tres veces y es correcto: el filtro mira la proporción, no el conteo.
    expect(
      validarTextoSustantivo(
        'Manual de marca con los usos correctos de la marca en papelería y la marca en redes sociales, incluyendo colores y tipografías.',
      ).valido,
    ).toBe(true);
  });
});

describe('medidas de diversidad', () => {
  it('diversidadLexica cae con la repetición', () => {
    expect(diversidadLexica('aaaaaaaa')).toBeLessThan(0.2);
    expect(diversidadLexica('cafetería de especialidad')).toBeGreaterThan(0.4);
  });

  it('diversidadDePalabras distingue repetición de variedad', () => {
    expect(diversidadDePalabras('hola hola hola')).toBeCloseTo(1 / 3, 2);
    expect(diversidadDePalabras('uno dos tres cuatro')).toBe(1);
  });

  it('el texto vacío no rompe ninguna de las dos', () => {
    expect(diversidadLexica('')).toBe(0);
    expect(diversidadDePalabras('   ')).toBe(0);
  });
});

describe('validarPresupuesto', () => {
  it('acepta importes razonables', () => {
    for (const valor of [50, 800, 3000, 1_000_000]) {
      expect(validarPresupuesto(valor).valido, String(valor)).toBe(true);
    }
  });

  it('rechaza lo que no es número', () => {
    for (const valor of ['800', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validarPresupuesto(valor).valido).toBe(false);
    }
  });

  it('rechaza cero y negativos', () => {
    expect(validarPresupuesto(0).valido).toBe(false);
    expect(validarPresupuesto(-100).valido).toBe(false);
  });

  it('rechaza por debajo del mínimo, explicando el motivo real', () => {
    // No es capricho: el plan se reparte entre 2 y 24 tareas, así que con 5 USD quedan
    // tareas de céntimos que ningún proveedor va a aceptar.
    const resultado = validarPresupuesto(5);
    expect(resultado.valido).toBe(false);
    expect(resultado.motivo).toContain('reparto entre tareas');
  });

  it('rechaza importes absurdos', () => {
    expect(validarPresupuesto(50_000_000).valido).toBe(false);
  });

  it('rechaza más de dos decimales', () => {
    expect(validarPresupuesto(100.555).valido).toBe(false);
    expect(validarPresupuesto(100.55).valido).toBe(true);
  });

  it('los límites son configurables', () => {
    expect(validarPresupuesto(10, { minimo: 5 }).valido).toBe(true);
  });
});
