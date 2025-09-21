import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import RedisStore from 'connect-redis';
import { createClient } from 'redis';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { setupSocketHandlers } from './socket/socketHandler';
import { sessionRoutes } from './routes/sessionRoutes';
import { participantRoutes } from './routes/participantRoutes';

dotenv.config();

const allowedOrigins = process.env.CORS_ORIGIN 
  ? [process.env.CORS_ORIGIN]
  : ["http://localhost:3003", "http://localhost:3000", "http://localhost:3002", "http://192.168.1.162:3003", "http://192.168.1.162:3002"];

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

const prisma = new PrismaClient();
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    await redisClient.connect();
    console.log('✅ Connected to Redis');

    await prisma.$connect();
    console.log('✅ Connected to PostgreSQL');

    const redisStore = new RedisStore({
      client: redisClient,
      prefix: "retroflow:",
    });

    // Trust proxy headers when running behind Railway's load balancer
    app.set('trust proxy', true);

    app.use(helmet({
      contentSecurityPolicy: false,
    }));

    app.use(cors({
      origin: allowedOrigins,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true
    }));

    const limiter = rateLimit({
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'), // 1 minute
      max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '1000'), // 1000 requests per minute
      message: 'Too many requests from this IP, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
      // Skip rate limiting for health checks and static assets
      skip: (req) => {
        return req.path === '/health' || req.path.startsWith('/static');
      }
    });
    app.use(limiter);

    app.use(session({
      store: redisStore,
      secret: process.env.SESSION_SECRET || 'fallback-secret-key',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      }
    }));

    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));

    app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    });

    app.use('/api/sessions', sessionRoutes(prisma));
    app.use('/api/participants', participantRoutes(prisma));

    setupSocketHandlers(io, prisma, redisClient);

    server.listen(Number(PORT), '0.0.0.0', () => {
      console.log(`🚀 RetroFlow backend running on port ${PORT}`);
      console.log(`📊 Health check: http://192.168.1.162:${PORT}/health`);
      console.log(`🔌 WebSocket server ready`);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('🔄 SIGTERM received, shutting down gracefully');
  await redisClient.quit();
  await prisma.$disconnect();
  server.close(() => {
    console.log('👋 Server closed');
    process.exit(0);
  });
});

startServer();