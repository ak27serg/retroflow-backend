import { Server, Socket } from 'socket.io';
import { PrismaClient, SessionPhase } from '@prisma/client';
import { RedisClientType } from 'redis';
import { z } from 'zod';

const joinSessionSchema = z.object({
  sessionId: z.string().uuid(),
  participantId: z.string().uuid(),
});

const changePhaseSchema = z.object({
  sessionId: z.string().uuid(),
  phase: z.nativeEnum(SessionPhase),
  timerDuration: z.number().optional(),
});

const responseSchema = z.object({
  sessionId: z.string().uuid(),
  participantId: z.string().uuid(),
  content: z.string().min(1).max(500),
  category: z.enum(['WENT_WELL', 'DIDNT_GO_WELL']),
});

const dragResponseSchema = z.object({
  sessionId: z.string().uuid(),
  responseId: z.string().uuid(),
  x: z.number(),
  y: z.number(),
  groupId: z.string().uuid().nullable(),
});

const voteSchema = z.object({
  sessionId: z.string().uuid(),
  participantId: z.string().uuid(),
  groupId: z.string(), // Can be group UUID or "individual-{responseId}"
  voteCount: z.number().min(0).max(4),
});

export function setupSocketHandlers(
  io: Server, 
  prisma: PrismaClient, 
  redis: any
) {
  io.on('connection', (socket: Socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    socket.on('join_session', async (data) => {
      try {
        const { sessionId, participantId } = joinSessionSchema.parse(data);
        
        const participant = await prisma.participant.findFirst({
          where: { id: participantId, sessionId },
          include: { session: true }
        });

        if (!participant) {
          socket.emit('error', { message: 'Participant not found' });
          return;
        }

        await prisma.participant.update({
          where: { id: participantId },
          data: { 
            socketId: socket.id,
            lastActive: new Date()
          }
        });

        socket.join(`session:${sessionId}`);
        
        const participants = await prisma.participant.findMany({
          where: { sessionId },
          select: {
            id: true,
            displayName: true,
            avatarId: true,
            isHost: true,
            lastActive: true,
            socketId: true
          }
        });

        socket.emit('session_joined', {
          session: participant.session,
          participant,
          participants: participants.map(p => ({
            ...p,
            isOnline: !!p.socketId
          }))
        });

        socket.to(`session:${sessionId}`).emit('participant_joined', {
          id: participant.id,
          displayName: participant.displayName,
          avatarId: participant.avatarId,
          isHost: participant.isHost,
          isOnline: true
        });

        await redis.setEx(`participant:${participantId}`, 3600, socket.id);

      } catch (error) {
        console.error('Join session error:', error);
        socket.emit('error', { message: 'Invalid session data' });
      }
    });

    socket.on('change_phase', async (data) => {
      try {
        const { sessionId, phase, timerDuration } = changePhaseSchema.parse(data);
        
        const session = await prisma.session.findUnique({
          where: { id: sessionId },
          include: { participants: { where: { socketId: socket.id } } }
        });

        if (!session || !session.participants[0]?.isHost) {
          socket.emit('error', { message: 'Unauthorized to change phase' });
          return;
        }

        const timerEndTime = timerDuration 
          ? new Date(Date.now() + timerDuration * 1000)
          : null;

        await prisma.session.update({
          where: { id: sessionId },
          data: { 
            currentPhase: phase,
            timerDuration: timerDuration || session.timerDuration,
            timerEndTime
          }
        });

        io.to(`session:${sessionId}`).emit('phase_changed', { 
          phase,
          timerEndTime: timerEndTime?.toISOString()
        });

      } catch (error) {
        console.error('Change phase error:', error);
        socket.emit('error', { message: 'Failed to change phase' });
      }
    });

    socket.on('typing_indicator', async (data) => {
      try {
        const { sessionId, participantId, isTyping } = z.object({
          sessionId: z.string().uuid(),
          participantId: z.string().uuid(),
          isTyping: z.boolean()
        }).parse(data);

        socket.to(`session:${sessionId}`).emit('participant_typing', {
          participantId,
          isTyping
        });

        const key = `typing:${sessionId}:${participantId}`;
        if (isTyping) {
          await redis.setEx(key, 10, socket.id);
        } else {
          await redis.del(key);
        }

      } catch (error) {
        console.error('Typing indicator error:', error);
      }
    });

    socket.on('add_response', async (data) => {
      try {
        const { sessionId, participantId, content, category } = responseSchema.parse(data);

        const response = await prisma.response.create({
          data: {
            sessionId,
            participantId,
            content,
            category
          },
          include: {
            participant: {
              select: { displayName: true, avatarId: true }
            }
          }
        });

        socket.emit('response_added', response);

      } catch (error) {
        console.error('Add response error:', error);
        socket.emit('error', { message: 'Failed to add response' });
      }
    });

    socket.on('update_response', async (data) => {
      try {
        const { responseId, content } = z.object({
          responseId: z.string().uuid(),
          content: z.string().min(1).max(500)
        }).parse(data);

        const response = await prisma.response.findFirst({
          where: { 
            id: responseId,
            participant: { socketId: socket.id }
          }
        });

        if (!response) {
          socket.emit('error', { message: 'Response not found or unauthorized' });
          return;
        }

        const updatedResponse = await prisma.response.update({
          where: { id: responseId },
          data: { content },
          include: {
            participant: {
              select: { displayName: true, avatarId: true }
            }
          }
        });

        socket.emit('response_updated', updatedResponse);

      } catch (error) {
        console.error('Update response error:', error);
        socket.emit('error', { message: 'Failed to update response' });
      }
    });

    socket.on('delete_response', async (data) => {
      try {
        const { responseId } = z.object({
          responseId: z.string().uuid()
        }).parse(data);

        const response = await prisma.response.findFirst({
          where: { 
            id: responseId,
            participant: { socketId: socket.id }
          }
        });

        if (!response) {
          socket.emit('error', { message: 'Response not found or unauthorized' });
          return;
        }

        await prisma.response.delete({
          where: { id: responseId }
        });

        socket.emit('response_deleted', { responseId });

      } catch (error) {
        console.error('Delete response error:', error);
        socket.emit('error', { message: 'Failed to delete response' });
      }
    });

    socket.on('create_group', async (data) => {
      try {
        const { sessionId, label, color, responseIds } = z.object({
          sessionId: z.string().uuid(),
          label: z.string().min(1).max(100),
          color: z.string(),
          responseIds: z.array(z.string().uuid()).optional()
        }).parse(data);

        const group = await prisma.group.create({
          data: {
            sessionId,
            label,
            color,
            positionX: 0,
            positionY: 0
          }
        });

        // If responseIds provided, assign them to this group
        if (responseIds && responseIds.length > 0) {
          await prisma.response.updateMany({
            where: {
              id: { in: responseIds },
              sessionId
            },
            data: {
              groupId: group.id
            }
          });
        }

        // Fetch the complete group with responses
        const completeGroup = await prisma.group.findUnique({
          where: { id: group.id },
          include: {
            responses: {
              include: {
                participant: {
                  select: { displayName: true, avatarId: true }
                }
              }
            }
          }
        });

        io.to(`session:${sessionId}`).emit('group_created', completeGroup);

      } catch (error) {
        console.error('Create group error:', error);
        socket.emit('error', { message: 'Failed to create group' });
      }
    });

    socket.on('update_group', async (data) => {
      try {
        const { groupId, label } = z.object({
          groupId: z.string().uuid(),
          label: z.string().min(1).max(100)
        }).parse(data);

        const updatedGroup = await prisma.group.update({
          where: { id: groupId },
          data: { label },
          include: {
            responses: {
              include: {
                participant: {
                  select: { displayName: true, avatarId: true }
                }
              }
            }
          }
        });

        io.to(`session:${updatedGroup.sessionId}`).emit('group_updated', updatedGroup);

      } catch (error) {
        console.error('Update group error:', error);
        socket.emit('error', { message: 'Failed to update group' });
      }
    });

    socket.on('drag_response', async (data) => {
      try {
        const { sessionId, responseId, x, y, groupId } = dragResponseSchema.parse(data);

        await prisma.response.update({
          where: { id: responseId },
          data: { 
            positionX: x,
            positionY: y,
            groupId
          }
        });

        io.to(`session:${sessionId}`).emit('response_dragged', {
          responseId,
          x,
          y,
          groupId
        });

      } catch (error) {
        console.error('Drag response error:', error);
        socket.emit('error', { message: 'Failed to move response' });
      }
    });

    socket.on('ungroup_response', async (data) => {
      try {
        const { responseId, sessionId } = z.object({
          responseId: z.string().uuid(),
          sessionId: z.string().uuid()
        }).parse(data);

        // Remove the response from its group
        await prisma.response.update({
          where: { id: responseId },
          data: { groupId: null }
        });

        io.to(`session:${sessionId}`).emit('response_ungrouped', { responseId });

      } catch (error) {
        console.error('Ungroup response error:', error);
        socket.emit('error', { message: 'Failed to ungroup response' });
      }
    });

    socket.on('cast_vote', async (data) => {
      try {
        const { sessionId, participantId, groupId, voteCount } = voteSchema.parse(data);

        let actualGroupId = groupId;

        // Handle individual response voting by creating a group for it
        if (groupId.startsWith('individual-')) {
          const responseId = groupId.replace('individual-', '');
          
          // Check if we already have a group for this individual response
          let existingGroup = await prisma.group.findFirst({
            where: {
              sessionId,
              responses: {
                some: {
                  id: responseId,
                  groupId: { not: null }
                }
              }
            }
          });

          if (!existingGroup) {
            // Get the response to create a group for it
            const response = await prisma.response.findUnique({
              where: { id: responseId },
              include: { participant: true }
            });

            if (!response) {
              socket.emit('error', { message: 'Response not found' });
              return;
            }

            // Create a group for this individual response
            const newGroup = await prisma.group.create({
              data: {
                sessionId,
                label: response.content.length > 30 
                  ? response.content.substring(0, 30) + '...'
                  : response.content,
                color: response.category === 'WENT_WELL' ? '#10b981' : '#ef4444',
                positionX: response.positionX,
                positionY: response.positionY
              }
            });

            // Assign the response to this group
            await prisma.response.update({
              where: { id: responseId },
              data: { groupId: newGroup.id }
            });

            actualGroupId = newGroup.id;
            existingGroup = newGroup;
          } else {
            actualGroupId = existingGroup.id;
          }
        }

        const totalVotes = await prisma.vote.aggregate({
          where: { sessionId, participantId },
          _sum: { voteCount: true }
        });

        const currentTotal = totalVotes._sum.voteCount || 0;
        if (currentTotal - (await getExistingVoteCount(participantId, actualGroupId)) + voteCount > 4) {
          socket.emit('error', { message: 'Insufficient votes remaining' });
          return;
        }

        if (voteCount === 0) {
          await prisma.vote.deleteMany({
            where: { participantId, groupId: actualGroupId }
          });
        } else {
          await prisma.vote.upsert({
            where: { 
              participantId_groupId: { participantId, groupId: actualGroupId }
            },
            update: { voteCount },
            create: { sessionId, participantId, groupId: actualGroupId, voteCount }
          });
        }

        const groupVotes = await prisma.vote.aggregate({
          where: { groupId: actualGroupId },
          _sum: { voteCount: true }
        });

        const totalGroupVotes = groupVotes._sum.voteCount || 0;

        // Update the group's vote count
        await prisma.group.update({
          where: { id: actualGroupId },
          data: { voteCount: totalGroupVotes }
        });

        io.to(`session:${sessionId}`).emit('votes_updated', {
          groupId: groupId, // Send back the original groupId (might be virtual)
          totalVotes: totalGroupVotes
        });

        async function getExistingVoteCount(participantId: string, groupId: string): Promise<number> {
          const vote = await prisma.vote.findUnique({
            where: { participantId_groupId: { participantId, groupId } }
          });
          return vote?.voteCount || 0;
        }

      } catch (error) {
        console.error('Cast vote error:', error);
        socket.emit('error', { message: 'Failed to cast vote' });
      }
    });

    socket.on('disconnect', async () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
      
      try {
        const participant = await prisma.participant.findFirst({
          where: { socketId: socket.id }
        });

        if (participant) {
          await prisma.participant.update({
            where: { id: participant.id },
            data: { 
              socketId: null,
              lastActive: new Date()
            }
          });

          socket.to(`session:${participant.sessionId}`).emit('participant_left', {
            participantId: participant.id
          });

          await redis.del(`participant:${participant.id}`);
          await redis.del(`typing:${participant.sessionId}:${participant.id}`);
        }

      } catch (error) {
        console.error('Disconnect cleanup error:', error);
      }
    });
  });
}