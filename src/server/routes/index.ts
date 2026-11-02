import { Router } from 'express';
import { authRoutes } from './authRoutes.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRoutes);
