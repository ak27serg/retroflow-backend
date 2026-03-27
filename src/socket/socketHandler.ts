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
  stopTimer: z.boolean().optional(),
});

const responseSchema = z.object({
  sessionId: z.string().uuid(),
  participantId: z.string().uuid(),
  content: z.string().min(1).max(500),
  category: z.enum(['WENT_WELL', 'DIDNT_GO_WELL']),
});


const voteSchema = z.object({
  sessionId: z.string().uuid(),
  participantId: z.string().uuid(),
  groupId: z.string(), // Can be group UUID or "individual-{responseId}"
  voteCount: z.number().min(0).max(4),
});

const createConnectionSchema = z.object({
  sessionId: z.string().uuid(),
  fromResponseId: z.string().uuid(),
  toResponseId: z.string().uuid(),
});

const removeConnectionSchema = z.object({
  sessionId: z.string().uuid(),
  connectionId: z.string().uuid(),
});

const dragResponseSchema = z.object({
  sessionId: z.string().uuid(),
  responseId: z.string().uuid(),
  x: z.number(),
  y: z.number(),
  isDragging: z.boolean(),
});

const lockCardsSchema = z.object({
  sessionId: z.string().uuid(),
  cardIds: z.array(z.string().uuid()).min(1).max(50),
});

const unlockCardsSchema = z.object({
  sessionId: z.string().uuid(),
  cardIds: z.array(z.string().uuid()).min(1).max(50),
});

const groupCardsSchema = z.object({
  sessionId: z.string().uuid(),
  cardId1: z.string().uuid(),
  cardId2: z.string().uuid(),
});

const ungroupCardSchema = z.object({
  sessionId: z.string().uuid(),
  cardId: z.string().uuid(),
});

const dragGroupSchema = z.object({
  sessionId: z.string().uuid(),
  positions: z.record(z.object({ x: z.number(), y: z.number() })).refine(
    val => Object.keys(val).length <= 50,
    { message: 'Too many positions' }
  ),
  isDragging: z.boolean(),
});

const renameGroupSchema = z.object({
  sessionId: z.string().uuid(),
  groupId: z.string().uuid(),
  label: z.string().max(100),
});

const presentationSchema = z.object({
  sessionId: z.string().uuid(),
});

const navigatePresentationSchema = z.object({
  sessionId: z.string().uuid(),
  itemIndex: z.number().int().min(0),
});

// In-memory card lock registry: cardId → socketId that holds the lock.
// Node.js single-threaded event loop guarantees atomic check-and-set — no race conditions.
const cardLocks = new Map<string, string>();

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
        const { sessionId, phase, timerDuration, stopTimer } = changePhaseSchema.parse(data);
        
        const session = await prisma.session.findUnique({
          where: { id: sessionId },
          include: { participants: { where: { socketId: socket.id } } }
        });

        if (!session || !session.participants[0]?.isHost) {
          socket.emit('error', { message: 'Unauthorized to change phase' });
          return;
        }

        let timerEndTime = null;
        
        if (stopTimer) {
          // Explicitly stop the timer
          timerEndTime = null;
        } else if (timerDuration) {
          // Set a new timer
          timerEndTime = new Date(Date.now() + timerDuration * 1000);
        }
        // If neither stopTimer nor timerDuration is specified, keep existing timer

        await prisma.session.update({
          where: { id: sessionId },
          data: { 
            currentPhase: phase,
            timerDuration: timerDuration || session.timerDuration,
            timerEndTime: stopTimer ? null : timerEndTime
          }
        });

        io.to(`session:${sessionId}`).emit('phase_changed', { 
          phase,
          timerEndTime: timerEndTime?.toISOString() || null
        });

      } catch (error) {
        console.error('Change phase error:', error);
        socket.emit('error', { message: 'Failed to change phase' });
      }
    });

    socket.on('typing_start', async (data) => {
      try {
        const { sessionId, participantId } = z.object({
          sessionId: z.string().uuid(),
          participantId: z.string().uuid()
        }).parse(data);

        socket.to(`session:${sessionId}`).emit('participant_typing_start', {
          participantId
        });

        const key = `typing:${sessionId}:${participantId}`;
        await redis.setEx(key, 10, socket.id);

      } catch (error) {
        console.error('Typing start error:', error);
      }
    });

    socket.on('typing_stop', async (data) => {
      try {
        const { sessionId, participantId } = z.object({
          sessionId: z.string().uuid(),
          participantId: z.string().uuid()
        }).parse(data);

        socket.to(`session:${sessionId}`).emit('participant_typing_stop', {
          participantId
        });

        const key = `typing:${sessionId}:${participantId}`;
        await redis.del(key);

      } catch (error) {
        console.error('Typing stop error:', error);
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





    socket.on('create_connection', async (data) => {
      try {
        const { sessionId, fromResponseId, toResponseId } = createConnectionSchema.parse(data);

        // Check if connection already exists
        const existingConnection = await prisma.connection.findFirst({
          where: {
            sessionId,
            OR: [
              { fromResponseId, toResponseId },
              { fromResponseId: toResponseId, toResponseId: fromResponseId }
            ]
          }
        });

        if (existingConnection) {
          socket.emit('error', { message: 'Connection already exists' });
          return;
        }

        // Verify both responses exist and belong to the session
        const responses = await prisma.response.findMany({
          where: {
            id: { in: [fromResponseId, toResponseId] },
            sessionId
          }
        });

        if (responses.length !== 2) {
          socket.emit('error', { message: 'Invalid responses for connection' });
          return;
        }

        // Create the connection
        const connection = await prisma.connection.create({
          data: {
            sessionId,
            fromResponseId,
            toResponseId
          }
        });

        io.to(`session:${sessionId}`).emit('connection_created', connection);

      } catch (error) {
        console.error('Create connection error:', error);
        socket.emit('error', { message: 'Failed to create connection' });
      }
    });

    socket.on('remove_connection', async (data) => {
      try {
        const { sessionId, connectionId } = removeConnectionSchema.parse(data);

        // Verify connection exists and belongs to session
        const connection = await prisma.connection.findFirst({
          where: { id: connectionId, sessionId }
        });

        if (!connection) {
          socket.emit('error', { message: 'Connection not found' });
          return;
        }

        // Remove the connection
        await prisma.connection.delete({
          where: { id: connectionId }
        });

        io.to(`session:${sessionId}`).emit('connection_removed', { connectionId });

      } catch (error) {
        console.error('Remove connection error:', error);
        socket.emit('error', { message: 'Failed to remove connection' });
      }
    });

    socket.on('drag_response', async (data) => {
      try {
        const { sessionId, responseId, x, y, isDragging } = dragResponseSchema.parse(data);

        // Persist to DB only on drop to avoid write-storm during drag
        if (!isDragging) {
          await prisma.response.update({
            where: { id: responseId },
            data: { positionX: Math.round(x), positionY: Math.round(y) }
          });
        }

        // Broadcast live position to all OTHER participants (sender updates locally)
        socket.to(`session:${sessionId}`).emit('card_moved', {
          responseId,
          x: Math.round(x),
          y: Math.round(y),
        });
      } catch (error) {
        console.error('Drag response error:', error);
      }
    });

    // ─── Card locking (mutual exclusion for dragging) ─────────────────────────

    socket.on('lock_cards', (data) => {
      try {
        const { sessionId, cardIds } = lockCardsSchema.parse(data);

        // First-claim-wins: reject if any card is already locked by someone else
        const conflicting = cardIds.filter(id => {
          const owner = cardLocks.get(id);
          return owner !== undefined && owner !== socket.id;
        });

        if (conflicting.length > 0) {
          socket.emit('lock_rejected', { cardIds: conflicting });
          return;
        }

        cardIds.forEach(id => cardLocks.set(id, socket.id));

        // Notify all OTHER participants — sender already knows they're dragging
        socket.to(`session:${sessionId}`).emit('cards_locked', { cardIds });
      } catch (error) {
        console.error('Lock cards error:', error);
      }
    });

    socket.on('unlock_cards', (data) => {
      try {
        const { sessionId, cardIds } = unlockCardsSchema.parse(data);

        const freed: string[] = [];
        cardIds.forEach(id => {
          if (cardLocks.get(id) === socket.id) {
            cardLocks.delete(id);
            freed.push(id);
          }
        });

        if (freed.length > 0) {
          // Notify all in room so every client updates lock state consistently
          io.to(`session:${sessionId}`).emit('cards_unlocked', { cardIds: freed });
        }
      } catch (error) {
        console.error('Unlock cards error:', error);
      }
    });

    // ─── Group management ──────────────────────────────────────────────────────

    socket.on('group_cards', async (data) => {
      try {
        const { sessionId, cardId1, cardId2 } = groupCardsSchema.parse(data);

        if (cardId1 === cardId2) return;

        const [r1, r2] = await Promise.all([
          prisma.response.findFirst({ where: { id: cardId1, sessionId } }),
          prisma.response.findFirst({ where: { id: cardId2, sessionId } }),
        ]);

        if (!r1 || !r2) return;

        let targetGroupId: string;

        if (r1.groupId && r2.groupId) {
          if (r1.groupId === r2.groupId) return; // already the same group
          // Merge r2's group into r1's group, then delete r2's group
          await prisma.response.updateMany({
            where: { groupId: r2.groupId, sessionId },
            data: { groupId: r1.groupId },
          });
          await prisma.group.delete({ where: { id: r2.groupId } });
          targetGroupId = r1.groupId;
        } else if (r1.groupId) {
          await prisma.response.update({ where: { id: cardId2 }, data: { groupId: r1.groupId } });
          targetGroupId = r1.groupId;
        } else if (r2.groupId) {
          await prisma.response.update({ where: { id: cardId1 }, data: { groupId: r2.groupId } });
          targetGroupId = r2.groupId;
        } else {
          const newGroup = await prisma.group.create({ data: { sessionId, color: '#3B82F6' } });
          await prisma.response.updateMany({
            where: { id: { in: [cardId1, cardId2] } },
            data: { groupId: newGroup.id },
          });
          targetGroupId = newGroup.id;
        }

        const grouped = await prisma.response.findMany({
          where: { groupId: targetGroupId, sessionId },
          select: { id: true },
        });

        io.to(`session:${sessionId}`).emit('cards_grouped', {
          groupId: targetGroupId,
          cardIds: grouped.map(r => r.id),
        });
      } catch (error) {
        console.error('Group cards error:', error);
      }
    });

    socket.on('ungroup_card', async (data) => {
      try {
        const { sessionId, cardId } = ungroupCardSchema.parse(data);

        const response = await prisma.response.findFirst({ where: { id: cardId, sessionId } });
        if (!response?.groupId) return;

        const groupId = response.groupId;

        await prisma.response.update({ where: { id: cardId }, data: { groupId: null } });

        const remainingCount = await prisma.response.count({ where: { groupId, sessionId } });

        if (remainingCount <= 1) {
          // Dissolve: detach last member and delete the group
          await prisma.response.updateMany({ where: { groupId, sessionId }, data: { groupId: null } });
          await prisma.group.delete({ where: { id: groupId } });
          io.to(`session:${sessionId}`).emit('group_dissolved', { groupId });
        } else {
          io.to(`session:${sessionId}`).emit('card_ungrouped', { cardId, groupId });
        }
      } catch (error) {
        console.error('Ungroup card error:', error);
      }
    });

    socket.on('drag_group', async (data) => {
      try {
        const { sessionId, positions, isDragging } = dragGroupSchema.parse(data);

        if (!isDragging) {
          // Batch-persist all final positions in one transaction on drop
          await prisma.$transaction(
            Object.entries(positions).map(([responseId, pos]) =>
              prisma.response.updateMany({
                where: { id: responseId, sessionId },
                data: { positionX: Math.round(pos.x), positionY: Math.round(pos.y) },
              })
            )
          );
        }

        socket.to(`session:${sessionId}`).emit('group_moved', { positions });
      } catch (error) {
        console.error('Drag group error:', error);
      }
    });

    socket.on('rename_group', async (data) => {
      try {
        const { sessionId, groupId, label } = renameGroupSchema.parse(data);
        const trimmed = label.trim() || null;
        await prisma.group.updateMany({
          where: { id: groupId, sessionId },
          data: { label: trimmed },
        });
        io.to(`session:${sessionId}`).emit('group_renamed', { groupId, label: trimmed });
      } catch (error) {
        console.error('Rename group error:', error);
      }
    });

    socket.on('cast_vote', async (data) => {
      try {
        const { sessionId, participantId, groupId, voteCount } = voteSchema.parse(data);

        let actualGroupId = groupId;

        // Handle connected response voting by creating a group for connected responses
        if (groupId.startsWith('connected-')) {
          console.log('Processing connected group vote:', groupId);
          
          // Extract response IDs - they are UUIDs separated by double dashes
          // Format: connected-uuid1--uuid2--uuid3
          const idsString = groupId.replace('connected-', '');
          const responseIds = idsString.split('--');
          
          console.log('Parsed response IDs from connected group:', responseIds);
          
          // Validate that we have valid UUIDs
          if (responseIds.length === 0 || responseIds.some(id => !id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))) {
            console.error('Invalid response IDs in connected group:', responseIds);
            socket.emit('error', { message: 'Invalid connected group format' });
            return;
          }
          
          // First, check if any of these responses are already grouped
          const existingGroupedResponses = await prisma.response.findMany({
            where: {
              id: { in: responseIds },
              sessionId,
              groupId: { not: null }
            },
            include: { group: true }
          });

          if (existingGroupedResponses.length > 0) {
            // Use the existing group from the first grouped response
            actualGroupId = existingGroupedResponses[0].groupId!;
            console.log(`Using existing group ${actualGroupId} for connected responses`);
          } else {
            // Get all the connected responses to create a group for them
            const responses = await prisma.response.findMany({
              where: { 
                id: { in: responseIds },
                sessionId,
                groupId: null // Only get ungrouped responses
              },
              include: { participant: true }
            });

            if (responses.length === 0) {
              console.error('No valid responses found for connected group:', responseIds);
              socket.emit('error', { message: 'Connected responses not found or already grouped' });
              return;
            }

            console.log(`Found ${responses.length} responses for connected group:`, responses.map(r => ({ id: r.id, content: r.content.substring(0, 30) })));

            // Create a group label from all response contents
            const groupLabel = responses
              .map(r => r.content.length > 20 ? r.content.substring(0, 20) + '...' : r.content)
              .join(' • ');

            console.log('Creating group with label:', groupLabel);

            // Create a group for these connected responses
            const newGroup = await prisma.group.create({
              data: {
                sessionId,
                label: groupLabel.length > 80 ? groupLabel.substring(0, 80) + '...' : groupLabel,
                color: responses[0].category === 'WENT_WELL' ? '#10b981' : '#ef4444',
                positionX: responses[0].positionX || 0,
                positionY: responses[0].positionY || 0
              }
            });

            console.log('Created group successfully:', newGroup.id);

            // Assign all connected responses to this group
            await prisma.response.updateMany({
              where: { id: { in: responseIds } },
              data: { groupId: newGroup.id }
            });

            actualGroupId = newGroup.id;
            
            // Emit event to refresh session data for all participants
            io.to(`session:${sessionId}`).emit('connected_group_created', {
              groupId: newGroup.id,
              responseIds
            });
          }
        }
        // Handle individual response voting by creating a group for it
        else if (groupId.startsWith('individual-')) {
          const responseId = groupId.replace('individual-', '');
          
          // Check if we already have a group for this individual response
          const existingGroup = await prisma.group.findFirst({
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
            
            // Emit event to refresh session data for all participants
            io.to(`session:${sessionId}`).emit('connected_group_created', {
              groupId: newGroup.id,
              responseIds: [responseId]
            });
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

        // Calculate individual participant voting progress for host visibility
        const allParticipantVotes = await prisma.vote.findMany({
          where: { sessionId },
          include: {
            participant: {
              select: { id: true, displayName: true, avatarId: true, isHost: true }
            }
          }
        });

        // Group votes by participant and calculate remaining votes
        const participantProgress = new Map<string, number>();
        const allParticipants = await prisma.participant.findMany({
          where: { sessionId },
          select: { id: true, displayName: true, avatarId: true, isHost: true }
        });

        allParticipants.forEach(p => {
          const participantVotes = allParticipantVotes.filter(vote => vote.participantId === p.id);
          const totalUsedVotes = participantVotes.reduce((sum, vote) => sum + vote.voteCount, 0);
          const remainingVotes = 4 - totalUsedVotes;
          participantProgress.set(p.id, remainingVotes);
        });

        io.to(`session:${sessionId}`).emit('votes_updated', {
          groupId: groupId, // Send back the original groupId (might be virtual)
          totalVotes: totalGroupVotes,
          participantProgress: Object.fromEntries(participantProgress) // Convert Map to object for JSON
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

    socket.on('start_presentation', async (data) => {
      try {
        console.log('Received start_presentation event:', data);
        const { sessionId } = presentationSchema.parse(data);
        
        // Verify host permissions
        const participant = await prisma.participant.findFirst({
          where: { socketId: socket.id, sessionId, isHost: true }
        });

        if (!participant) {
          console.log('Unauthorized presentation start attempt by socket:', socket.id);
          socket.emit('error', { message: 'Unauthorized to start presentation' });
          return;
        }

        console.log('Broadcasting presentation_started to session:', sessionId);
        
        // Debug: Check which sockets are in the room
        const socketsInRoom = await io.in(`session:${sessionId}`).fetchSockets();
        console.log('Sockets in room session:' + sessionId + ':', socketsInRoom.map(s => s.id));
        
        // Broadcast presentation start to all participants in the session
        io.to(`session:${sessionId}`).emit('presentation_started');

      } catch (error) {
        console.error('Start presentation error:', error);
        socket.emit('error', { message: 'Failed to start presentation' });
      }
    });

    socket.on('end_presentation', async (data) => {
      try {
        const { sessionId } = presentationSchema.parse(data);
        
        // Verify host permissions
        const participant = await prisma.participant.findFirst({
          where: { socketId: socket.id, sessionId, isHost: true }
        });

        if (!participant) {
          socket.emit('error', { message: 'Unauthorized to end presentation' });
          return;
        }

        // Broadcast presentation end to all participants in the session
        io.to(`session:${sessionId}`).emit('presentation_ended');

      } catch (error) {
        console.error('End presentation error:', error);
        socket.emit('error', { message: 'Failed to end presentation' });
      }
    });

    socket.on('navigate_presentation', async (data) => {
      try {
        const { sessionId, itemIndex } = navigatePresentationSchema.parse(data);
        
        // Verify host permissions
        const participant = await prisma.participant.findFirst({
          where: { socketId: socket.id, sessionId, isHost: true }
        });

        if (!participant) {
          socket.emit('error', { message: 'Unauthorized to navigate presentation' });
          return;
        }

        // Broadcast navigation to all participants in the session
        io.to(`session:${sessionId}`).emit('presentation_navigate', { itemIndex });

      } catch (error) {
        console.error('Navigate presentation error:', error);
        socket.emit('error', { message: 'Failed to navigate presentation' });
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

          // Release all card locks held by this socket
          const freedCards: string[] = [];
          for (const [cardId, socketId] of cardLocks.entries()) {
            if (socketId === socket.id) {
              cardLocks.delete(cardId);
              freedCards.push(cardId);
            }
          }
          if (freedCards.length > 0) {
            socket.to(`session:${participant.sessionId}`).emit('cards_unlocked', { cardIds: freedCards });
          }
        }

      } catch (error) {
        console.error('Disconnect cleanup error:', error);
      }
    });
  });
}