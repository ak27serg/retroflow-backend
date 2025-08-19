import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const updateParticipantSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  avatarId: z.string().min(1).max(20).optional()
});

export function participantRoutes(prisma: PrismaClient) {
  const router = Router();

  router.get('/:participantId', async (req, res) => {
    try {
      const { participantId } = z.object({
        participantId: z.string().uuid()
      }).parse(req.params);

      const participant = await prisma.participant.findUnique({
        where: { id: participantId },
        include: {
          session: {
            select: {
              id: true,
              title: true,
              currentPhase: true,
              timerEndTime: true
            }
          },
          responses: true,
          votes: {
            include: {
              group: true
            }
          }
        }
      });

      if (!participant) {
        return res.status(404).json({ error: 'Participant not found' });
      }

      res.json(participant);

    } catch (error) {
      console.error('Get participant error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid participant ID' });
      }
      res.status(500).json({ error: 'Failed to fetch participant' });
    }
  });

  router.patch('/:participantId', async (req, res) => {
    try {
      const { participantId } = z.object({
        participantId: z.string().uuid()
      }).parse(req.params);

      const updateData = updateParticipantSchema.parse(req.body);

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'No update data provided' });
      }

      if (updateData.displayName) {
        const participant = await prisma.participant.findUnique({
          where: { id: participantId }
        });

        if (!participant) {
          return res.status(404).json({ error: 'Participant not found' });
        }

        const existingParticipant = await prisma.participant.findFirst({
          where: {
            sessionId: participant.sessionId,
            displayName: {
              equals: updateData.displayName,
              mode: 'insensitive'
            },
            id: { not: participantId }
          }
        });

        if (existingParticipant) {
          return res.status(400).json({ error: 'Display name already taken' });
        }
      }

      const updatedParticipant = await prisma.participant.update({
        where: { id: participantId },
        data: updateData
      });

      res.json(updatedParticipant);

    } catch (error) {
      console.error('Update participant error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid request data', details: error.errors });
      }
      res.status(500).json({ error: 'Failed to update participant' });
    }
  });

  router.delete('/:participantId', async (req, res) => {
    try {
      const { participantId } = z.object({
        participantId: z.string().uuid()
      }).parse(req.params);

      const participant = await prisma.participant.findUnique({
        where: { id: participantId }
      });

      if (!participant) {
        return res.status(404).json({ error: 'Participant not found' });
      }

      if (participant.isHost) {
        const otherParticipants = await prisma.participant.findMany({
          where: {
            sessionId: participant.sessionId,
            id: { not: participantId }
          }
        });

        if (otherParticipants.length > 0) {
          await prisma.participant.update({
            where: { id: otherParticipants[0].id },
            data: { isHost: true }
          });
        }
      }

      await prisma.participant.delete({
        where: { id: participantId }
      });

      res.status(204).send();

    } catch (error) {
      console.error('Delete participant error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid participant ID' });
      }
      res.status(500).json({ error: 'Failed to delete participant' });
    }
  });

  router.get('/:participantId/responses', async (req, res) => {
    try {
      const { participantId } = z.object({
        participantId: z.string().uuid()
      }).parse(req.params);

      const responses = await prisma.response.findMany({
        where: { participantId },
        include: {
          group: true,
          participant: {
            select: { displayName: true, avatarId: true }
          }
        },
        orderBy: { createdAt: 'asc' }
      });

      res.json(responses);

    } catch (error) {
      console.error('Get participant responses error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid participant ID' });
      }
      res.status(500).json({ error: 'Failed to fetch responses' });
    }
  });

  router.get('/:participantId/votes', async (req, res) => {
    try {
      const { participantId } = z.object({
        participantId: z.string().uuid()
      }).parse(req.params);

      const votes = await prisma.vote.findMany({
        where: { participantId },
        include: {
          group: {
            include: {
              responses: {
                select: {
                  id: true,
                  content: true,
                  category: true
                }
              }
            }
          }
        }
      });

      const totalVotes = votes.reduce((sum, vote) => sum + vote.voteCount, 0);
      const remainingVotes = Math.max(0, 4 - totalVotes);

      res.json({
        votes,
        totalVotes,
        remainingVotes
      });

    } catch (error) {
      console.error('Get participant votes error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid participant ID' });
      }
      res.status(500).json({ error: 'Failed to fetch votes' });
    }
  });

  return router;
}