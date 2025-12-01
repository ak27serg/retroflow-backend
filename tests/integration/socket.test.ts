import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { io as SocketClient, Socket as ClientSocket } from 'socket.io-client';
import { prisma } from '../../src/utils/prisma';
import { setupSocketHandlers } from '../../src/socket/socketHandler';
import {
  createTestSession,
  createTestResponses,
  TestSession,
  TestParticipant,
  simulateConcurrentOperations,
  waitForCondition,
} from '../utils/testHelpers';
import { v4 as uuidv4 } from 'uuid';

describe('Socket.IO Real-time Collaboration', () => {
  let httpServer: any;
  let io: SocketServer;
  let testSession: TestSession;
  let participants: TestParticipant[];
  let clientSockets: ClientSocket[] = [];
  const port = 3002;

  beforeAll(async () => {
    // Setup test server
    httpServer = createServer();
    io = new SocketServer(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    // Setup socket handlers
    setupSocketHandlers(io);

    // Start server
    await new Promise<void>((resolve) => {
      httpServer.listen(port, resolve);
    });
  });

  afterAll(async () => {
    // Close all connections and server
    clientSockets.forEach(socket => socket.close());
    io.close();
    await new Promise<void>((resolve) => {
      httpServer.close(resolve);
    });
  });

  beforeEach(async () => {
    // Create test session and participants
    testSession = await createTestSession({
      title: 'Socket Test Session',
      participantCount: 4,
      withHost: true,
    });
    participants = testSession.participants;

    // Clear client sockets from previous tests
    clientSockets.forEach(socket => socket.close());
    clientSockets = [];
  });

  afterEach(async () => {
    // Disconnect all clients
    clientSockets.forEach(socket => socket.close());
    clientSockets = [];
  });

  const createClientSocket = (): Promise<ClientSocket> => {
    return new Promise((resolve, reject) => {
      const socket = SocketClient(`http://localhost:${port}`);
      
      socket.on('connect', () => {
        clientSockets.push(socket);
        resolve(socket);
      });

      socket.on('connect_error', (error) => {
        reject(error);
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        reject(new Error('Socket connection timeout'));
      }, 5000);
    });
  };

  describe('Connection and Authentication', () => {
    test('should connect multiple clients simultaneously', async () => {
      const connectionPromises = participants.map(() => createClientSocket());
      const sockets = await Promise.all(connectionPromises);

      expect(sockets).toHaveLength(participants.length);

      // Verify all sockets are connected
      sockets.forEach(socket => {
        expect(socket.connected).toBe(true);
      });
    });

    test('should handle session joining for multiple participants', async () => {
      const socket1 = await createClientSocket();
      const socket2 = await createClientSocket();

      // Track join events
      const joinEvents: any[] = [];
      socket1.on('participant_joined', (data) => joinEvents.push({ socket: 1, data }));
      socket2.on('participant_joined', (data) => joinEvents.push({ socket: 2, data }));

      // Join session with first participant
      await new Promise<void>((resolve) => {
        socket1.emit('join_session', {
          sessionId: testSession.id,
          participantId: participants[0].id,
        });
        socket1.on('session_joined', resolve);
      });

      // Join session with second participant
      await new Promise<void>((resolve) => {
        socket2.emit('join_session', {
          sessionId: testSession.id,
          participantId: participants[1].id,
        });
        socket2.on('session_joined', resolve);
      });

      // Wait for join events to propagate
      await waitForCondition(() => joinEvents.length >= 1, 2000);

      expect(joinEvents.length).toBeGreaterThan(0);
    });

    test('should handle rapid succession of join/leave events', async () => {
      const sockets = await Promise.all([
        createClientSocket(),
        createClientSocket(),
        createClientSocket(),
      ]);

      // Track connection events
      const events: any[] = [];
      sockets.forEach((socket, index) => {
        socket.on('participant_joined', (data) => events.push({ type: 'joined', socket: index, data }));
        socket.on('participant_left', (data) => events.push({ type: 'left', socket: index, data }));
      });

      // Join all participants
      await Promise.all(sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index].id,
          });
          socket.on('session_joined', resolve);
        })
      ));

      // Disconnect some participants
      sockets[1].close();
      sockets[2].close();

      // Wait for events to propagate
      await waitForCondition(() => events.length > 0, 3000);

      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('Real-time Response Synchronization', () => {
    test('should broadcast response creation to all participants', async () => {
      const sockets = await Promise.all([createClientSocket(), createClientSocket()]);

      // Join session with both participants
      await Promise.all(sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index].id,
          });
          socket.on('session_joined', resolve);
        })
      ));

      // Track response events
      const responseEvents: any[] = [];
      sockets.forEach((socket, index) => {
        socket.on('response_added', (data) => {
          responseEvents.push({ socket: index, data });
        });
      });

      // Add response via first socket
      sockets[0].emit('add_response', {
        sessionId: testSession.id,
        participantId: participants[0].id,
        content: 'Real-time test response',
        category: 'WENT_WELL',
        positionX: 100,
        positionY: 100,
      });

      // Wait for response events
      await waitForCondition(() => responseEvents.length >= 2, 3000);

      // Both sockets should receive the event
      expect(responseEvents).toHaveLength(2);
      expect(responseEvents[0].data.content).toBe('Real-time test response');
      expect(responseEvents[1].data.content).toBe('Real-time test response');
    });

    test('should handle concurrent response updates from multiple users', async () => {
      // Create initial responses
      const responses = await createTestResponses(testSession.id, participants.slice(0, 2), 1);
      
      const sockets = await Promise.all([createClientSocket(), createClientSocket()]);

      // Join sessions
      await Promise.all(sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index].id,
          });
          socket.on('session_joined', resolve);
        })
      ));

      // Track update events
      const updateEvents: any[] = [];
      sockets.forEach((socket, index) => {
        socket.on('response_updated', (data) => {
          updateEvents.push({ socket: index, data });
        });
      });

      // Update responses concurrently
      const updateOperations = responses.map((response, index) => 
        () => {
          sockets[index].emit('update_response', {
            sessionId: testSession.id,
            responseId: response.id,
            content: `Updated by socket ${index}`,
            category: response.category,
          });
        }
      );

      await simulateConcurrentOperations(updateOperations, 100);

      // Wait for all update events
      await waitForCondition(() => updateEvents.length >= 4, 5000); // 2 updates × 2 sockets

      expect(updateEvents.length).toBe(4);
    });

    test('should synchronize response positions during drag operations', async () => {
      const response = (await createTestResponses(testSession.id, [participants[0]], 1))[0];
      
      const sockets = await Promise.all([createClientSocket(), createClientSocket()]);

      // Join sessions
      await Promise.all(sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index].id,
          });
          socket.on('session_joined', resolve);
        })
      ));

      // Track drag events
      const dragEvents: any[] = [];
      sockets.forEach((socket, index) => {
        socket.on('response_dragged', (data) => {
          dragEvents.push({ socket: index, data });
        });
      });

      // Simulate drag operation
      sockets[0].emit('drag_response', {
        sessionId: testSession.id,
        responseId: response.id,
        newX: 250,
        newY: 150,
      });

      // Wait for drag events
      await waitForCondition(() => dragEvents.length >= 2, 3000);

      expect(dragEvents).toHaveLength(2);
      expect(dragEvents[0].data.newX).toBe(250);
      expect(dragEvents[0].data.newY).toBe(150);
      expect(dragEvents[1].data.newX).toBe(250);
      expect(dragEvents[1].data.newY).toBe(150);
    });
  });

  describe('Real-time Group Management', () => {
    test('should broadcast group creation to all participants', async () => {
      const sockets = await Promise.all([createClientSocket(), createClientSocket()]);

      // Join sessions
      await Promise.all(sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index].id,
          });
          socket.on('session_joined', resolve);
        })
      ));

      // Track group events
      const groupEvents: any[] = [];
      sockets.forEach((socket, index) => {
        socket.on('group_created', (data) => {
          groupEvents.push({ socket: index, data });
        });
      });

      // Create group
      sockets[0].emit('create_group', {
        sessionId: testSession.id,
        label: 'Real-time Group',
        color: '#10b981',
        positionX: 200,
        positionY: 200,
      });

      // Wait for group creation events
      await waitForCondition(() => groupEvents.length >= 2, 3000);

      expect(groupEvents).toHaveLength(2);
      expect(groupEvents[0].data.label).toBe('Real-time Group');
    });

    test('should handle concurrent group operations from multiple users', async () => {
      const sockets = await Promise.all([
        createClientSocket(), 
        createClientSocket(),
        createClientSocket()
      ]);

      // Join sessions
      await Promise.all(sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index].id,
          });
          socket.on('session_joined', resolve);
        })
      ));

      // Track all group events
      const allEvents: any[] = [];
      sockets.forEach((socket, index) => {
        socket.on('group_created', (data) => allEvents.push({ type: 'created', socket: index, data }));
        socket.on('group_updated', (data) => allEvents.push({ type: 'updated', socket: index, data }));
      });

      // Create groups concurrently
      const groupOperations = sockets.map((socket, index) => 
        () => {
          socket.emit('create_group', {
            sessionId: testSession.id,
            label: `Group by socket ${index}`,
            color: '#10b981',
            positionX: 100 + (index * 100),
            positionY: 100,
          });
        }
      );

      await simulateConcurrentOperations(groupOperations, 50);

      // Wait for all events
      await waitForCondition(() => allEvents.length >= 9, 5000); // 3 creates × 3 sockets

      const createdEvents = allEvents.filter(e => e.type === 'created');
      expect(createdEvents).toHaveLength(9);
    });
  });

  describe('Real-time Voting Synchronization', () => {
    test('should broadcast vote updates to all participants', async () => {
      // Create a group to vote on
      const group = await prisma.group.create({
        data: {
          id: uuidv4(),
          sessionId: testSession.id,
          label: 'Voting Test Group',
          color: '#10b981',
          positionX: 100,
          positionY: 100,
          voteCount: 0,
        },
      });

      const sockets = await Promise.all([createClientSocket(), createClientSocket()]);

      // Join sessions
      await Promise.all(sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index].id,
          });
          socket.on('session_joined', resolve);
        })
      ));

      // Track vote events
      const voteEvents: any[] = [];
      sockets.forEach((socket, index) => {
        socket.on('votes_updated', (data) => {
          voteEvents.push({ socket: index, data });
        });
      });

      // Cast vote
      sockets[0].emit('cast_vote', {
        sessionId: testSession.id,
        participantId: participants[0].id,
        groupId: group.id,
        voteCount: 3,
      });

      // Wait for vote events
      await waitForCondition(() => voteEvents.length >= 2, 3000);

      expect(voteEvents).toHaveLength(2);
      expect(voteEvents[0].data.groupId).toBe(group.id);
      expect(voteEvents[0].data.voteCount).toBe(3);
    });

    test('should handle concurrent voting from multiple participants', async () => {
      // Create multiple groups for voting
      const groups = await Promise.all([1, 2].map(i => 
        prisma.group.create({
          data: {
            id: uuidv4(),
            sessionId: testSession.id,
            label: `Vote Group ${i}`,
            color: '#10b981',
            positionX: i * 100,
            positionY: 100,
            voteCount: 0,
          },
        })
      ));

      const sockets = await Promise.all([
        createClientSocket(),
        createClientSocket(),
        createClientSocket()
      ]);

      // Join sessions
      await Promise.all(sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index].id,
          });
          socket.on('session_joined', resolve);
        })
      ));

      // Track vote events
      const voteEvents: any[] = [];
      sockets.forEach((socket, index) => {
        socket.on('votes_updated', (data) => {
          voteEvents.push({ socket: index, data });
        });
      });

      // Cast votes concurrently
      const voteOperations = sockets.map((socket, index) => 
        () => {
          const targetGroup = groups[index % groups.length];
          socket.emit('cast_vote', {
            sessionId: testSession.id,
            participantId: participants[index].id,
            groupId: targetGroup.id,
            voteCount: 2,
          });
        }
      );

      await simulateConcurrentOperations(voteOperations, 100);

      // Wait for all vote events
      await waitForCondition(() => voteEvents.length >= 9, 5000); // 3 votes × 3 sockets

      expect(voteEvents).toHaveLength(9);

      // Verify vote distribution
      const group1Events = voteEvents.filter(e => e.data.groupId === groups[0].id);
      const group2Events = voteEvents.filter(e => e.data.groupId === groups[1].id);
      
      expect(group1Events.length + group2Events.length).toBe(9);
    });
  });

  describe('Phase Transitions and Synchronization', () => {
    test('should broadcast phase changes to all participants', async () => {
      const sockets = await Promise.all([createClientSocket(), createClientSocket()]);

      // Join sessions
      await Promise.all(sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index].id,
          });
          socket.on('session_joined', resolve);
        })
      ));

      // Track phase change events
      const phaseEvents: any[] = [];
      sockets.forEach((socket, index) => {
        socket.on('phase_changed', (data) => {
          phaseEvents.push({ socket: index, data });
        });
      });

      // Host changes phase
      const hostParticipant = participants.find(p => p.isHost)!;
      sockets[0].emit('change_phase', {
        sessionId: testSession.id,
        phase: 'INPUT',
        hostId: hostParticipant.id,
      });

      // Wait for phase change events
      await waitForCondition(() => phaseEvents.length >= 2, 3000);

      expect(phaseEvents).toHaveLength(2);
      expect(phaseEvents[0].data.phase).toBe('INPUT');
      expect(phaseEvents[1].data.phase).toBe('INPUT');
    });

    test('should maintain session state consistency during phase transitions', async () => {
      // Create some test data
      const responses = await createTestResponses(testSession.id, participants.slice(0, 2), 1);
      
      const sockets = await Promise.all([createClientSocket(), createClientSocket()]);

      // Join sessions
      await Promise.all(sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index].id,
          });
          socket.on('session_joined', resolve);
        })
      ));

      // Change phase to INPUT
      const hostParticipant = participants.find(p => p.isHost)!;
      sockets[0].emit('change_phase', {
        sessionId: testSession.id,
        phase: 'INPUT',
        hostId: hostParticipant.id,
      });

      // Wait for phase change
      await waitForCondition(async () => {
        const session = await prisma.session.findUnique({ where: { id: testSession.id } });
        return session!.phase === 'INPUT';
      }, 3000);

      // Verify responses are still there
      const sessionResponses = await prisma.response.findMany({
        where: { sessionId: testSession.id },
      });

      expect(sessionResponses).toHaveLength(responses.length);
    });
  });

  describe('Typing Indicators', () => {
    test('should broadcast typing indicators to host', async () => {
      const hostSocket = await createClientSocket();
      const participantSocket = await createClientSocket();

      // Join sessions
      await Promise.all([
        new Promise<void>((resolve) => {
          const host = participants.find(p => p.isHost)!;
          hostSocket.emit('join_session', {
            sessionId: testSession.id,
            participantId: host.id,
          });
          hostSocket.on('session_joined', resolve);
        }),
        new Promise<void>((resolve) => {
          const participant = participants.find(p => !p.isHost)!;
          participantSocket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participant.id,
          });
          participantSocket.on('session_joined', resolve);
        })
      ]);

      // Track typing events
      const typingEvents: any[] = [];
      hostSocket.on('participant_typing_start', (data) => {
        typingEvents.push({ type: 'start', data });
      });
      hostSocket.on('participant_typing_stop', (data) => {
        typingEvents.push({ type: 'stop', data });
      });

      // Simulate typing
      const participant = participants.find(p => !p.isHost)!;
      participantSocket.emit('typing_start', {
        sessionId: testSession.id,
        participantId: participant.id,
      });

      // Wait for typing event
      await waitForCondition(() => typingEvents.length >= 1, 2000);

      expect(typingEvents).toHaveLength(1);
      expect(typingEvents[0].type).toBe('start');
      expect(typingEvents[0].data.participantId).toBe(participant.id);
    });
  });

  describe('Error Handling and Recovery', () => {
    test('should handle socket disconnection and reconnection gracefully', async () => {
      const socket = await createClientSocket();

      // Join session
      await new Promise<void>((resolve) => {
        socket.emit('join_session', {
          sessionId: testSession.id,
          participantId: participants[0].id,
        });
        socket.on('session_joined', resolve);
      });

      // Disconnect
      socket.close();

      // Reconnect with new socket
      const newSocket = await createClientSocket();
      
      // Rejoin session
      await new Promise<void>((resolve) => {
        newSocket.emit('join_session', {
          sessionId: testSession.id,
          participantId: participants[0].id,
        });
        newSocket.on('session_joined', resolve);
      });

      expect(newSocket.connected).toBe(true);
    });

    test('should handle invalid event data gracefully', async () => {
      const socket = await createClientSocket();

      // Join session first
      await new Promise<void>((resolve) => {
        socket.emit('join_session', {
          sessionId: testSession.id,
          participantId: participants[0].id,
        });
        socket.on('session_joined', resolve);
      });

      // Track error events
      const errorEvents: any[] = [];
      socket.on('error', (data) => {
        errorEvents.push(data);
      });

      // Send invalid data
      socket.emit('add_response', {
        sessionId: 'invalid-id',
        content: '', // Invalid empty content
      });

      // Wait for error
      await waitForCondition(() => errorEvents.length > 0, 2000);

      expect(errorEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Scalability and Performance', () => {
    test('should handle multiple concurrent socket connections', async () => {
      const socketCount = 10;
      const connectionPromises = Array.from({ length: socketCount }, () => createClientSocket());
      
      const startTime = Date.now();
      const sockets = await Promise.all(connectionPromises);
      const endTime = Date.now();

      expect(sockets).toHaveLength(socketCount);
      expect(endTime - startTime).toBeLessThan(3000); // Should connect within 3 seconds

      // Join all to session
      const joinPromises = sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index % participants.length].id,
          });
          socket.on('session_joined', resolve);
        })
      );

      await Promise.all(joinPromises);

      // Verify all are connected
      sockets.forEach(socket => {
        expect(socket.connected).toBe(true);
      });
    });

    test('should broadcast events efficiently to many participants', async () => {
      const socketCount = 8;
      const sockets = await Promise.all(
        Array.from({ length: socketCount }, () => createClientSocket())
      );

      // Join all sockets to session
      await Promise.all(sockets.map((socket, index) => 
        new Promise<void>((resolve) => {
          socket.emit('join_session', {
            sessionId: testSession.id,
            participantId: participants[index % participants.length].id,
          });
          socket.on('session_joined', resolve);
        })
      ));

      // Track events
      const eventCounts = new Array(socketCount).fill(0);
      sockets.forEach((socket, index) => {
        socket.on('response_added', () => {
          eventCounts[index]++;
        });
      });

      // Add response
      const startTime = Date.now();
      sockets[0].emit('add_response', {
        sessionId: testSession.id,
        participantId: participants[0].id,
        content: 'Broadcast test response',
        category: 'WENT_WELL',
      });

      // Wait for all events to be received
      await waitForCondition(() => eventCounts.every(count => count > 0), 3000);
      const endTime = Date.now();

      expect(eventCounts.every(count => count === 1)).toBe(true);
      expect(endTime - startTime).toBeLessThan(1000); // Should broadcast quickly
    });
  });
});