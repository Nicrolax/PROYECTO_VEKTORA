/**
 * Autorización de los trabajos programados.
 *
 * Es la superficie más sensible de la aplicación: estos disparadores ejecutan a los agentes
 * con la clave de servicio y sin ninguna sesión de usuario. Un fallo aquí no se nota hasta
 * que alguien consume cuota ajena o mueve reputación que no le corresponde.
 */

import { describe, expect, it } from 'vitest';
import { autorizarCron, igualSeguro } from '@/lib/cron/autorizacion';

const cabecera = (valor?: string): Headers =>
  new Headers(valor === undefined ? {} : { authorization: valor });

describe('autorizarCron', () => {
  it('sin CRON_SECRET configurado CIERRA la puerta, no la abre', () => {
    // El modo de fallo peligroso sería «no hay secreto, entonces todo vale».
    const resultado = autorizarCron(cabecera('Bearer lo-que-sea'), {});
    expect(resultado.autorizado).toBe(false);
    if (!resultado.autorizado) {
      expect(resultado.estado).toBe(503);
      expect(resultado.motivo).toContain('CRON_SECRET');
    }
  });

  it('un secreto en blanco cuenta como ausente', () => {
    const resultado = autorizarCron(cabecera('Bearer   '), { CRON_SECRET: '   ' });
    expect(resultado.autorizado).toBe(false);
  });

  it('acepta el secreto correcto', () => {
    expect(autorizarCron(cabecera('Bearer s3cr3to'), { CRON_SECRET: 's3cr3to' }).autorizado).toBe(
      true,
    );
  });

  it('rechaza un secreto incorrecto de la misma longitud', () => {
    const resultado = autorizarCron(cabecera('Bearer s3cr3tX'), { CRON_SECRET: 's3cr3to' });
    expect(resultado.autorizado).toBe(false);
    if (!resultado.autorizado) expect(resultado.estado).toBe(401);
  });

  it('rechaza sin cabecera y sin el prefijo Bearer', () => {
    expect(autorizarCron(cabecera(), { CRON_SECRET: 's3cr3to' }).autorizado).toBe(false);
    expect(autorizarCron(cabecera('s3cr3to'), { CRON_SECRET: 's3cr3to' }).autorizado).toBe(false);
  });

  it('no confunde un prefijo del secreto con el secreto', () => {
    expect(autorizarCron(cabecera('Bearer s3c'), { CRON_SECRET: 's3cr3to' }).autorizado).toBe(false);
  });

  it('el motivo del rechazo no revela el secreto esperado', () => {
    const resultado = autorizarCron(cabecera('Bearer malo123'), { CRON_SECRET: 's3cr3to' });
    if (!resultado.autorizado) expect(resultado.motivo).not.toContain('s3cr3to');
  });
});

describe('igualSeguro', () => {
  it('compara contenido, no referencia', () => {
    expect(igualSeguro('abc', 'abc')).toBe(true);
    expect(igualSeguro('abc', 'abd')).toBe(false);
  });

  it('longitudes distintas nunca son iguales, y no lanza', () => {
    expect(igualSeguro('abc', 'abcdef')).toBe(false);
    expect(igualSeguro('', 'x')).toBe(false);
  });

  it('maneja caracteres no ASCII sin romperse', () => {
    expect(igualSeguro('contraseña', 'contraseña')).toBe(true);
    expect(igualSeguro('contraseña', 'contrasena')).toBe(false);
  });
});
