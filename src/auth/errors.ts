/** Error con código HTTP: lo lanza la lógica de autenticación y el middleware lo expone tal cual. */
export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}
