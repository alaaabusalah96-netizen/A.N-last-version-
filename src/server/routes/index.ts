import { Router } from 'express';
import { authRoutes } from './authRoutes.js';
import { companyRoutes } from './companyRoutes.js';
import { accountingRoutes } from './accountingRoutes.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRoutes);
apiRouter.use('/companies', companyRoutes);
apiRouter.use('/accounting', accountingRoutes);
