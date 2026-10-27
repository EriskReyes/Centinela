/**
 * Kit de pruebas y demos — un autenticador WebAuthn VIRTUAL.
 *
 * Hace lo que haría tu móvil o Windows Hello: genera una clave EC P-256,
 * produce respuestas de registro (attestation 'none') y de autenticación
 * firmadas de verdad con la clave privada. Permite probar el flujo completo
 * de firma —criptografía incluida— sin depender de un navegador ni de un
 * dispositivo físico.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as signBytes } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';

function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

/** SimpleWebAuthn tipa los bytes como Uint8Array<ArrayBuffer>; los Buffer hay que reencajarlos. */
function u8(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/** CBOR mínimo para las estructuras fijas que necesitamos (attestationObject y clave COSE). */
function cborByteString(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 24) {
    return Buffer.concat([Buffer.from([0x40 + bytes.length]), Buffer.from(bytes)]);
  }
  return Buffer.concat([Buffer.from([0x58, bytes.length]), Buffer.from(bytes)]);
}

function cborAttestationNone(authData: Uint8Array): Uint8Array {
  // {"fmt":"none","attStmt":{},"authData": <bytes>}
  const head = Buffer.from('a363666d74646e6f6e656761747453746d74a0686175746844617461', 'hex');
  return Buffer.concat([head, cborByteString(authData)]);
}

function cborCoseEc2P256(x: Uint8Array, y: Uint8Array): Uint8Array {
  // {1:2, 3:-7, -1:1, -2:x, -3:y}
  return Buffer.concat([
    Buffer.from('a5', 'hex'),
    Buffer.from('01', 'hex'),
    Buffer.from('02', 'hex'),
    Buffer.from('03', 'hex'),
    Buffer.from('26', 'hex'),
    Buffer.from('20', 'hex'),
    Buffer.from('01', 'hex'),
    Buffer.from('21', 'hex'),
    cborByteString(x),
    Buffer.from('22', 'hex'),
    cborByteString(y),
  ]);
}

export interface FakeAuthenticatorKeyMaterial {
  credentialId: Buffer;
  publicKeyCOSE: Uint8Array;
  privateKeyPem: string;
}

export class FakeAuthenticator {
  readonly credentialId: Buffer;
  readonly publicKeyCOSE: Uint8Array;
  private readonly privateKeyPem: string;
  private readonly rpID: string;
  private readonly origin: string;
  private counter = 0;

  constructor(rpID: string, origin: string, keyMaterial?: FakeAuthenticatorKeyMaterial) {
    this.rpID = rpID;
    this.origin = origin;
    if (keyMaterial !== undefined) {
      // Clon de una llave existente: un atacante con el material robado.
      this.credentialId = keyMaterial.credentialId;
      this.publicKeyCOSE = keyMaterial.publicKeyCOSE;
      this.privateKeyPem = keyMaterial.privateKeyPem;
      return;
    }
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const jwk = publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x as string, 'base64url');
    const y = Buffer.from(jwk.y as string, 'base64url');
    this.publicKeyCOSE = cborCoseEc2P256(x, y);
    this.credentialId = randomBytes(32);
  }

  /** credentialId en base64url (igual que lo expone un navegador). */
  get id(): string {
    return isoBase64URL.fromBuffer(u8(this.credentialId));
  }

  /** Clona esta llave con otro rpID/origen: simula a un atacante con el material robado. */
  clone(rpID: string = this.rpID, origin: string = this.origin): FakeAuthenticator {
    return new FakeAuthenticator(rpID, origin, {
      credentialId: this.credentialId,
      publicKeyCOSE: this.publicKeyCOSE,
      privateKeyPem: this.privateKeyPem,
    });
  }

  /** Produce la respuesta de registro (attestation 'none'). */
  register(options: PublicKeyCredentialCreationOptionsJSON): RegistrationResponseJSON {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }),
      'utf8',
    );
    const authData = Buffer.concat([
      sha256(Buffer.from(this.rpID, 'utf8')),
      Buffer.from([0x45]), // flags: UP | UV | AT
      Buffer.alloc(4), // contador de registro = 0
      Buffer.alloc(16), // aaguid
      (() => {
        const len = Buffer.alloc(2);
        len.writeUInt16BE(this.credentialId.length);
        return len;
      })(),
      this.credentialId,
      this.publicKeyCOSE,
    ]);
    return {
      id: this.id,
      rawId: this.id,
      response: {
        attestationObject: isoBase64URL.fromBuffer(u8(cborAttestationNone(authData))),
        clientDataJSON: isoBase64URL.fromBuffer(u8(clientDataJSON)),
        transports: ['internal'],
      },
      type: 'public-key',
      clientExtensionResults: {},
    };
  }

  /** Firma el reto pedido y produce la respuesta de autenticación. */
  assert(options: PublicKeyCredentialRequestOptionsJSON): AuthenticationResponseJSON {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }),
      'utf8',
    );
    const clientDataHash = sha256(clientDataJSON);
    this.counter += 1;
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(this.counter);
    const authData = Buffer.concat([
      sha256(Buffer.from(this.rpID, 'utf8')),
      Buffer.from([0x05]), // flags: UP | UV
      counterBytes,
    ]);
    const signature = signBytes('SHA256', Buffer.concat([authData, clientDataHash]), this.privateKeyPem);
    return {
      id: this.id,
      rawId: this.id,
      response: {
        authenticatorData: isoBase64URL.fromBuffer(u8(authData)),
        clientDataJSON: isoBase64URL.fromBuffer(u8(clientDataJSON)),
        signature: isoBase64URL.fromBuffer(u8(signature)),
      },
      type: 'public-key',
      clientExtensionResults: {},
    };
  }
}

/**
 * Rompe la firma de una aserción de forma DETERMINISTA.
 *
 * OJO: voltear el ÚLTIMO carácter de base64url no siempre cambia los bytes
 * decodificados (cuando la longitud es 2 mod 4, el último carácter solo aporta
 * bits de padding y la "firma manipulada" sigue siendo válida). El primer
 * carácter siempre es significativo.
 */
export function tamperAssertion(assertion: AuthenticationResponseJSON): AuthenticationResponseJSON {
  const signature = assertion.response.signature;
  const first = signature[0] === 'A' ? 'B' : 'A';
  return {
    ...assertion,
    response: { ...assertion.response, signature: first + signature.slice(1) },
  };
}
