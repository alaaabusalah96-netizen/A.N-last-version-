import { Request, Response, NextFunction, RequestHandler } from 'express';

export function wrap(
  fn: (req: any, res: Response, next: NextFunction) => Promise<any>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
