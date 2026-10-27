/**
 * Fase 2 (configuración) — La política de la empresa.
 *
 * La política es lo que el panel de administración (Fase 6) podrá ajustar sin
 * tocar código. El motor la recibe como entrada y nunca decide "a mano":
 * toda decisión es función de (acción, política). El esquema Zod valida
 * cualquier política que llegue de la base de datos o del panel.
 */
import { z } from 'zod';

const ISO_4217 = /^[A-Z]{3}$/;

export const TypePolicySchema = z.object({
  /** false → toda acción de este tipo se bloquea sin mirar nada más. */
  allowed: z.boolean(),
  /** Importe ≤ allowLimitMinor → permitir sin firma. */
  allowLimitMinor: z.number().int().nonnegative().optional(),
  /** Importe ≤ signLimitMinor → requiere firma; por encima → bloquear. */
  signLimitMinor: z.number().int().nonnegative().optional(),
  /** Monedas aceptadas (ISO 4217). Ausente/vacío → cualquier moneda. */
  currencies: z.array(z.string().regex(ISO_4217)).optional(),
  /** Cuarto ojos: firmas de personas distintas exigidas por encima del umbral. */
  quorumSignatures: z.number().int().positive().optional(),
  /** Umbral (en unidades menores) a partir del cual se exige el quórum. */
  quorumAboveMinor: z.number().int().nonnegative().optional(),
  /**
   * Roles autorizados a firmar el quórum. Si se define, TODAS las firmas de
   * la acción deben venir de llaves con uno de estos roles (403 si no).
   */
  quorumRoles: z.array(z.string().min(1)).optional(),
  /**
   * Tope de gasto aprobado SIN firma por un mismo agente dentro de la ventana
   * (misma moneda). Si la acción lo haría superar → requiere firma. Corta el
   * fraccionamiento: 20 pagos de 99 € no pasan por debajo del radar.
   */
  cumulativeAllowLimitMinor: z.number().int().nonnegative().optional(),
  /** Ventana del tope acumulado, en minutos. */
  cumulativeWindowMinutes: z.number().int().positive().optional(),
});
export type TypePolicy = z.infer<typeof TypePolicySchema>;

export const PolicySchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    types: z.object({
      payment: TypePolicySchema,
      reservation: TypePolicySchema,
      loan: TypePolicySchema,
      data_access: TypePolicySchema,
    }),
    /** Destinos prohibidos; un patrón terminado en '*' coincide por prefijo. */
    destinationDeny: z.array(z.string().min(1)),
    /** Destinos de confianza; no disparan la regla de "destino nuevo". */
    destinationTrusted: z.array(z.string().min(1)),
    /** Destino fuera de la lista de confianza → exige firma humana. */
    requireSignOnNewDestination: z.boolean(),
    /** Minutos de vida de una solicitud pendiente de firma antes de expirar. */
    pendingTtlMinutes: z.number().int().positive(),
  })
  .superRefine((policy, ctx) => {
    // Coherencia de límites: el umbral de firma debe superar al de aprobación automática.
    for (const [type, typePolicy] of Object.entries(policy.types)) {
      if (
        typePolicy.allowLimitMinor !== undefined &&
        typePolicy.signLimitMinor !== undefined &&
        typePolicy.signLimitMinor <= typePolicy.allowLimitMinor
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['types', type, 'signLimitMinor'],
          message: `el límite de firma debe ser mayor que el de aprobación automática (${type})`,
        });
      }
      // Cuarto ojos: el umbral de quórum debe estar dentro de la banda de firma.
      if (typePolicy.quorumAboveMinor !== undefined && typePolicy.quorumSignatures === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['types', type, 'quorumSignatures'],
          message: `quorumAboveMinor exige definir quorumSignatures (${type})`,
        });
      }
      // Roles sin quórum no tienen efecto: hay que definir quorumSignatures.
      if (typePolicy.quorumRoles !== undefined && typePolicy.quorumSignatures === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['types', type, 'quorumSignatures'],
          message: `quorumRoles exige definir quorumSignatures (${type})`,
        });
      }
      // El tope acumulado y su ventana van juntos: uno sin el otro no significa nada.
      if ((typePolicy.cumulativeAllowLimitMinor === undefined) !== (typePolicy.cumulativeWindowMinutes === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['types', type, 'cumulativeWindowMinutes'],
          message: `cumulativeAllowLimitMinor y cumulativeWindowMinutes se definen juntos (${type})`,
        });
      }
      if (
        typePolicy.quorumAboveMinor !== undefined &&
        typePolicy.signLimitMinor !== undefined &&
        typePolicy.quorumAboveMinor > typePolicy.signLimitMinor
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['types', type, 'quorumAboveMinor'],
          message: `quorumAboveMinor debe estar dentro del umbral de firma (${type})`,
        });
      }
    }
  });
export type Policy = z.infer<typeof PolicySchema>;

/**
 * Política de ejemplo para la demo: "asistente de compras de una PYME".
 * Importes en unidades menores: 100_00 = 100,00 EUR.
 */
export const DEFAULT_POLICY: Policy = {
  id: 'policy-pyme-demo',
  version: 1,
  types: {
    payment: {
      allowed: true,
      allowLimitMinor: 100_00,
      signLimitMinor: 1_000_00,
      currencies: ['EUR', 'USD', 'CHF'],
      // Cuarto ojos: entre 500,00 y 1.000,00 € hacen falta DOS personas distintas,
      // ambas con rol autorizador: dos empleados no pueden firmarse entre ellos.
      quorumSignatures: 2,
      quorumAboveMinor: 500_00,
      quorumRoles: ['autorizador'],
      // Como mucho 300,00 € al día sin firma por agente, aunque cada pago sea pequeño.
      cumulativeAllowLimitMinor: 300_00,
      cumulativeWindowMinutes: 24 * 60,
    },
    reservation: {
      allowed: true,
      allowLimitMinor: 50_00,
      signLimitMinor: 500_00,
      currencies: ['EUR', 'USD', 'CHF'],
      cumulativeAllowLimitMinor: 150_00,
      cumulativeWindowMinutes: 24 * 60,
    },
    loan: { allowed: false },
    data_access: { allowed: true },
  },
  destinationDeny: ['crypto:*', 'dataset:secretos-*'],
  destinationTrusted: ['amazon.es', 'adobe.com', 'dataset:publico-*'],
  requireSignOnNewDestination: true,
  pendingTtlMinutes: 15,
};
