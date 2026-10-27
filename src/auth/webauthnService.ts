/**
 * Fase 4 — Servicio WebAuthn: registro de llaves y firma de acciones.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import type { AgentAction } from '../domain/action.ts';
import { challengeForAction, type HumanDecision } from './signing.ts';
import type { ChallengeRepository, CredentialRepository } from './repos.ts';
import { AuthError } from './errors.ts';

export interface RelyingParty {
  rpName: string;
  rpID: string;
  origin: string;
}

export interface WebAuthnServiceDeps {
  rp: RelyingParty;
  credentials: CredentialRepository;
  challenges: ChallengeRepository;
  now?: () => Date;
}

const CHALLENGE_TTL_MINUTES = 5;

export function createWebAuthnService(deps: WebAuthnServiceDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    /** Opciones para registrar una llave nueva; el reto queda guardado (un solo uso). */
    async registrationOptions(userId: string, userName: string) {
      const existing = await deps.credentials.listByUser(userId);
      const options = await generateRegistrationOptions({
        rpName: deps.rp.rpName,
        rpID: deps.rp.rpID,
        userID: isoUint8Array.fromUTF8String(userId),
        userName,
        attestationType: 'none',
        excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required' },
      });
      await deps.challenges.saveRegistration(userId, options.challenge, now(), CHALLENGE_TTL_MINUTES);
      return options;
    },

    /** Verifica la respuesta de registro y guarda la credencial con su rol. */
    async verifyRegistration(userId: string, role: string, response: RegistrationResponseJSON) {
      const expectedChallenge = await deps.challenges.consumeRegistration(userId, now());
      if (expectedChallenge === null) {
        throw new AuthError('no hay un registro en curso: pide opciones de nuevo');
      }
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge,
          expectedOrigin: deps.rp.origin,
          expectedRPID: deps.rp.rpID,
        });
      } catch (err) {
        throw new AuthError(`verificación de registro fallida: ${err instanceof Error ? err.message : err}`);
      }
      if (!verification.verified || verification.registrationInfo === undefined) {
        throw new AuthError('la llave no pudo verificarse');
      }
      const info = verification.registrationInfo;
      await deps.credentials.insert({
        id: info.credential.id,
        userId,
        role,
        publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        createdAt: now(),
      });
      return { credentialId: info.credential.id };
    },

    /**
     * Opciones para firmar una acción pendiente. El reto es el hash de los
     * datos exactos de la acción + la decisión (aprobar o rechazar).
     */
    async signOptions(action: AgentAction, decision: HumanDecision, userId: string) {
      const userCredentials = await deps.credentials.listByUser(userId);
      if (userCredentials.length === 0) {
        throw new AuthError(`'${userId}' no tiene llaves registradas: registra una primero`);
      }
      const challenge = challengeForAction(action, decision);
      const options = await generateAuthenticationOptions({
        rpID: deps.rp.rpID,
        // OJO: SimpleWebAuthn recodifica un challenge string como UTF-8; hay que
        // pasar los bytes del hash para que el reto firmado sea exactamente él.
        challenge: isoBase64URL.toBuffer(challenge),
        allowCredentials: userCredentials.map((c) => ({ id: c.id, transports: c.transports })),
        userVerification: 'required',
      });
      await deps.challenges.saveSigning(action.id, decision, challenge, now(), CHALLENGE_TTL_MINUTES);
      return options;
    },

    /**
     * Verifica la firma contra la credencial registrada y actualiza el contador
     * anti-replay. La llave debe pertenecer a la persona que dice estar firmando
     * (cuarto ojos: no se puede firmar en nombre de otro).
     */
    async verifySignature(
      action: AgentAction,
      decision: HumanDecision,
      userId: string,
      response: AuthenticationResponseJSON,
    ) {
      const expectedChallenge = await deps.challenges.consumeSigning(action.id, decision, now());
      if (expectedChallenge === null) {
        throw new AuthError('no hay un reto pendiente para esta firma (¿reutilizando una firma?)');
      }
      const credential = await deps.credentials.findById(response.id);
      if (credential === null) {
        throw new AuthError('la llave usada no está registrada en Centinela');
      }
      if (credential.revokedAt !== undefined) {
        throw new AuthError('esta llave fue revocada por un administrador', 403);
      }
      if (credential.userId !== userId) {
        throw new AuthError(`la llave usada pertenece a '${credential.userId}', no a '${userId}'`, 400);
      }
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: deps.rp.origin,
          expectedRPID: deps.rp.rpID,
          credential: {
            id: credential.id,
            publicKey: isoBase64URL.toBuffer(credential.publicKey),
            counter: credential.counter,
            transports: credential.transports,
          },
        });
      } catch (err) {
        throw new AuthError(`verificación de firma fallida: ${err instanceof Error ? err.message : err}`);
      }
      if (!verification.verified) {
        throw new AuthError('la firma no pudo verificarse');
      }
      await deps.credentials.updateCounter(credential.id, verification.authenticationInfo.newCounter);
      return { credentialId: credential.id, userId: credential.userId, role: credential.role };
    },
  };
}

export type WebAuthnService = ReturnType<typeof createWebAuthnService>;
