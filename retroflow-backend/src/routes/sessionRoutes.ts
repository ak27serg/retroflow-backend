import { Router } from 'express';
import { PrismaClient, SessionPhase } from '@prisma/client';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

const createSessionSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  hostName: z.string().min(1).max(50),
  hostAvatar: z.string().min(1).max(20)
});

const joinSessionSchema = z.object({
  inviteCode: z.string().length(8),
  displayName: z.string().min(1).max(50),
  avatarId: z.string().min(1).max(20)
});

function generateInviteCode(): string {
  const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function sessionRoutes(prisma: PrismaClient) {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      const { title, hostName, hostAvatar } = createSessionSchema.parse(req.body);
      
      const sessionId = uuidv4();
      const hostId = uuidv4();
      const inviteCode = generateInviteCode();

      const session = await prisma.session.create({
        data: {
          id: sessionId,
          inviteCode,
          hostId,
          title: title || 'Retrospective',
          participants: {
            create: {
              id: hostId,
              displayName: hostName,
              avatarId: hostAvatar,
              isHost: true
            }
          }
        },
        include: {
          participants: true
        }
      });

      res.status(201).json({
        session,
        inviteUrl: `${req.protocol}://${req.get('host')}/join/${inviteCode}`
      });

    } catch (error) {
      console.error('Create session error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid request data', details: error.errors });
      }
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  router.post('/join', async (req, res) => {
    try {
      const { inviteCode, displayName, avatarId } = joinSessionSchema.parse(req.body);
      
      const session = await prisma.session.findUnique({
        where: { inviteCode },
        include: { participants: true }
      });

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.participants.length >= 15) {
        return res.status(400).json({ error: 'Session is full' });
      }

      const existingParticipant = session.participants.find(
        p => p.displayName.toLowerCase() === displayName.toLowerCase()
      );

      if (existingParticipant) {
        return res.status(400).json({ error: 'Display name already taken' });
      }

      const participant = await prisma.participant.create({
        data: {
          sessionId: session.id,
          displayName,
          avatarId,
          isHost: false
        }
      });

      res.status(201).json({
        session: {
          id: session.id,
          title: session.title,
          currentPhase: session.currentPhase,
          timerEndTime: session.timerEndTime
        },
        participant
      });

    } catch (error) {
      console.error('Join session error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid request data', details: error.errors });
      }
      res.status(500).json({ error: 'Failed to join session' });
    }
  });

  router.get('/:sessionId', async (req, res) => {
    try {
      const { sessionId } = z.object({
        sessionId: z.string().uuid()
      }).parse(req.params);

      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          participants: {
            select: {
              id: true,
              displayName: true,
              avatarId: true,
              isHost: true,
              lastActive: true,
              socketId: true
            }
          },
          responses: {
            include: {
              participant: {
                select: { displayName: true, avatarId: true }
              }
            }
          },
          groups: {
            include: {
              responses: {
                include: {
                  participant: {
                    select: { displayName: true, avatarId: true }
                  }
                }
              }
            }
          },
          votes: {
            include: {
              participant: {
                select: { displayName: true, avatarId: true }
              }
            }
          }
        }
      });

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const sessionData = {
        ...session,
        participants: session.participants.map(p => ({
          ...p,
          isOnline: !!p.socketId
        }))
      };

      res.json(sessionData);

    } catch (error) {
      console.error('Get session error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }
      res.status(500).json({ error: 'Failed to fetch session' });
    }
  });

  router.get('/invite/:inviteCode', async (req, res) => {
    try {
      const { inviteCode } = z.object({
        inviteCode: z.string().length(8)
      }).parse(req.params);

      const session = await prisma.session.findUnique({
        where: { inviteCode },
        select: {
          id: true,
          title: true,
          currentPhase: true,
          createdAt: true,
          _count: {
            select: { participants: true }
          }
        }
      });

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.json({
        id: session.id,
        title: session.title,
        currentPhase: session.currentPhase,
        participantCount: session._count.participants,
        createdAt: session.createdAt
      });

    } catch (error) {
      console.error('Get session by invite error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid invite code' });
      }
      res.status(500).json({ error: 'Failed to fetch session' });
    }
  });

  router.patch('/:sessionId/phase', async (req, res) => {
    try {
      const { sessionId } = z.object({
        sessionId: z.string().uuid()
      }).parse(req.params);

      const { phase, timerDuration } = z.object({
        phase: z.nativeEnum(SessionPhase),
        timerDuration: z.number().optional()
      }).parse(req.body);

      const timerEndTime = timerDuration 
        ? new Date(Date.now() + timerDuration * 1000)
        : null;

      const session = await prisma.session.update({
        where: { id: sessionId },
        data: { 
          currentPhase: phase,
          timerDuration: timerDuration || undefined,
          timerEndTime
        }
      });

      res.json(session);

    } catch (error) {
      console.error('Update phase error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid request data', details: error.errors });
      }
      res.status(500).json({ error: 'Failed to update phase' });
    }
  });

  return router;
}