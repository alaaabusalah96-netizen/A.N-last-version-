import { Router } from 'express';
import { authRoutes } from './authRoutes.js';
import { companyRoutes } from './companyRoutes.js';
import { accountingRoutes } from './accountingRoutes.js';
import { userAdminRoutes } from './userAdminRoutes.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRoutes);
apiRouter.use('/companies', companyRoutes);
apiRouter.use('/accounting', accountingRoutes);
apiRouter.use('/users', userAdminRoutes);

export { authRoutes, companyRoutes, accountingRoutes, userAdminRoutes };
