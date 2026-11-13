import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RektrsRolesService } from '@gitroom/nestjs-libraries/rektrs/rektrs.roles.service';
import { RektrsFunction } from '@gitroom/nestjs-libraries/rektrs/rektrs.roles';

export const REKTRS_FUNCTIONS_KEY = 'rektrs:functions';

/**
 * Require at least one of the given REKTRS org functions (design P3-1 §5).
 * Org role SUPERADMIN/ADMIN members hold all five by default resolution;
 * the CASL quota guard is untouched and keeps doing its own job.
 */
export const RequireRektrsFunctions = (...functions: RektrsFunction[]) =>
  SetMetadata(REKTRS_FUNCTIONS_KEY, functions);

@Injectable()
export class RektrsFunctionsGuard implements CanActivate {
  constructor(
    private _reflector: Reflector,
    private _roles: RektrsRolesService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this._reflector.getAllAndOverride<RektrsFunction[]>(
      REKTRS_FUNCTIONS_KEY,
      [context.getHandler(), context.getClass()]
    );
    if (!required || !required.length) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const org = request.org;
    if (!user || !org) {
      throw new UnauthorizedException({
        code: 'REKTRS_AUTH_REQUIRED',
        message: 'An authenticated org session is required',
      });
    }
    const functions = await this._roles.getFunctions(org.id, user.id);
    request.rektrsFunctions = functions;
    if (!required.some((fn) => functions.includes(fn))) {
      throw new ForbiddenException({
        code: 'REKTRS_FUNCTION_REQUIRED',
        message: `Requires one of the REKTRS functions: ${required.join(', ')}`,
      });
    }
    return true;
  }
}
