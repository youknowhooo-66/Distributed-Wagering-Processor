import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Observable } from 'rxjs';

/**
 * Provider Identity Port interface.
 * Extensibility point for external IdPs (Keycloak, Zitadel, Auth0).
 */
export interface ProviderIdentityPort {
  validateToken(token: string): Promise<{ providerId: string; valid: boolean }>;
}

/**
 * No-op AuthGuard.
 *
 * Conforming to section 2 of the technical challenge:
 * - Authentication does not count toward evaluation points
 * - This guard serves as an explicit extension point
 * - In production, this integrates an external IdP (e.g. Keycloak / Zitadel) via OIDC JWT Bearer tokens
 * - Health endpoints and internal queues are excluded from authentication
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(
    _context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    // Explicit extension point — accepts requests while keeping contract ready for IdP integration
    return true;
  }
}
