import { describe, test, expect, beforeEach } from '@jest/globals';
import { prisma } from '../../src/utils/prisma';
import {
  createTestSession,
  simulateConcurrentOperations,
  waitForCondition,
  getSessionState,
  TestSession,
  TestParticipant,
} from '../utils/testHelpers';
import { v4 as uuidv4 } from 'uuid';

describe('Multi-User Concurrent Input', () => {
  let testSession: TestSession;
  let participants: TestParticipant[];

  beforeEach(async () => {
    testSession = await createTestSession({
      title: 'Concurrent Test Session',
      participantCount: 6,
      withHost: true,
    });
    participants = testSession.participants;
  });

  describe('Concurrent Response Creation', () => {
    test('should handle multiple users creating responses simultaneously', async () => {
      const responseOperations = participants.map((participant, index) => 
        () => prisma.response.create({
          data: {
            id: uuidv4(),
            sessionId: testSession.id,
            participantId: participant.id,
            content: `Concurrent response from ${participant.displayName} - ${index}`,
            category: index % 2 === 0 ? 'WENT_WELL' : 'DIDNT_GO_WELL',
            positionX: Math.random() * 800,
            positionY: Math.random() * 600,
          },
        })
      );

      const startTime = Date.now();
      const responses = await simulateConcurrentOperations(responseOperations);
      const endTime = Date.now();

      expect(responses).toHaveLength(participants.length);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete quickly

      // Verify all responses were created
      const sessionState = await getSessionState(testSession.id);
      expect(sessionState!.responses).toHaveLength(participants.length);

      // Verify each participant has exactly one response
      for (const participant of participants) {
        const participantResponses = sessionState!.responses.filter(
          r => r.participantId === participant.id
        );
        expect(participantResponses).toHaveLength(1);
      }
    });

    test('should handle rapid response updates from multiple users', async () => {
      // First create initial responses
      const initialResponses = await Promise.all(
        participants.map(participant => 
          prisma.response.create({
            data: {
              id: uuidv4(),
              sessionId: testSession.id,
              participantId: participant.id,
              content: `Initial response from ${participant.displayName}`,
              category: 'WENT_WELL',
            },
          })
        )
      );

      // Then update them all concurrently
      const updateOperations = initialResponses.map((response, index) => 
        () => prisma.response.update({
          where: { id: response.id },
          data: {
            content: `Updated response ${Date.now()} - ${index}`,
          },
        })
      );

      const updatedResponses = await simulateConcurrentOperations(updateOperations, 50);

      expect(updatedResponses).toHaveLength(initialResponses.length);

      // Verify all updates were applied
      const finalResponses = await prisma.response.findMany({
        where: { sessionId: testSession.id },
      });

      for (const response of finalResponses) {
        expect(response.content).toContain('Updated response');
      }
    });

    test('should handle concurrent response deletion safely', async () => {
      // Create responses for each participant
      const responses = await Promise.all(
        participants.map(participant => 
          prisma.response.create({
            data: {
              id: uuidv4(),
              sessionId: testSession.id,
              participantId: participant.id,
              content: `Response to delete from ${participant.displayName}`,
              category: 'DIDNT_GO_WELL',
            },
          })
        )
      );

      // Delete half of them concurrently
      const responsesToDelete = responses.slice(0, Math.floor(responses.length / 2));
      const deleteOperations = responsesToDelete.map(response => 
        () => prisma.response.delete({
          where: { id: response.id },
        })
      );

      await simulateConcurrentOperations(deleteOperations);

      // Verify correct number of responses remain
      const remainingResponses = await prisma.response.findMany({
        where: { sessionId: testSession.id },
      });

      expect(remainingResponses).toHaveLength(responses.length - responsesToDelete.length);
    });
  });

  describe('Concurrent Group Operations', () => {
    test('should handle concurrent group creation and response assignment', async () => {
      // Create responses first
      const responses = await Promise.all(
        participants.map(participant => 
          prisma.response.create({
            data: {
              id: uuidv4(),
              sessionId: testSession.id,
              participantId: participant.id,
              content: `Response for grouping from ${participant.displayName}`,
              category: 'WENT_WELL',
              positionX: Math.random() * 400,
              positionY: Math.random() * 300,
            },
          })
        )
      );

      // Create groups concurrently and assign responses
      const groupOperations = participants.slice(0, 3).map((participant, index) => 
        async () => {
          const groupId = uuidv4();
          
          // Create group
          const group = await prisma.group.create({
            data: {
              id: groupId,
              sessionId: testSession.id,
              label: `Group ${index + 1} by ${participant.displayName}`,
              color: '#10b981',
              positionX: 100 + (index * 200),
              positionY: 100 + (index * 150),
              voteCount: 0,
            },
          });

          // Assign some responses to this group
          const responsesToAssign = responses.slice(index * 2, (index + 1) * 2);
          await prisma.response.updateMany({
            where: {
              id: { in: responsesToAssign.map(r => r.id) },
              groupId: null, // Only assign if not already grouped
            },
            data: {
              groupId: group.id,
            },
          });

          return group;
        }
      );

      const groups = await simulateConcurrentOperations(groupOperations);

      expect(groups).toHaveLength(3);

      // Verify groups were created and responses assigned
      const sessionState = await getSessionState(testSession.id);
      expect(sessionState!.groups).toHaveLength(3);

      // Verify responses are properly grouped
      const groupedResponses = sessionState!.responses.filter(r => r.groupId !== null);
      expect(groupedResponses.length).toBeGreaterThan(0);
    });

    test('should handle concurrent group updates without conflicts', async () => {
      // Create a group first
      const group = await prisma.group.create({
        data: {
          id: uuidv4(),
          sessionId: testSession.id,
          label: 'Test Group for Updates',
          color: '#ef4444',
          positionX: 200,
          positionY: 200,
          voteCount: 0,
        },
      });

      // Multiple participants try to update the group simultaneously
      const updateOperations = participants.slice(0, 4).map((participant, index) => 
        () => prisma.group.update({
          where: { id: group.id },
          data: {
            label: `Updated by ${participant.displayName} at ${Date.now()}`,
            positionX: 200 + (index * 10), // Slightly different positions
            positionY: 200 + (index * 10),
          },
        })
      );

      const updatedGroups = await simulateConcurrentOperations(updateOperations, 25);

      expect(updatedGroups).toHaveLength(4);

      // Verify the final state
      const finalGroup = await prisma.group.findUnique({
        where: { id: group.id },
      });

      expect(finalGroup).toBeDefined();
      expect(finalGroup!.label).toContain('Updated by');
    });
  });

  describe('Concurrent Voting Operations', () => {
    test('should handle concurrent voting by multiple users', async () => {
      // Set up groups for voting
      const group1 = await prisma.group.create({
        data: {
          id: uuidv4(),
          sessionId: testSession.id,
          label: 'Vote Target Group 1',
          color: '#10b981',
          positionX: 100,
          positionY: 100,
          voteCount: 0,
        },
      });

      const group2 = await prisma.group.create({
        data: {
          id: uuidv4(),
          sessionId: testSession.id,
          label: 'Vote Target Group 2',
          color: '#ef4444',
          positionX: 300,
          positionY: 100,
          voteCount: 0,
        },
      });

      // Each participant votes simultaneously
      const voteOperations = participants.map((participant, index) => 
        async () => {
          const targetGroup = index % 2 === 0 ? group1 : group2;
          const voteCount = Math.floor(Math.random() * 3) + 1; // 1-3 votes

          const vote = await prisma.vote.create({
            data: {
              id: uuidv4(),
              sessionId: testSession.id,
              participantId: participant.id,
              groupId: targetGroup.id,
              voteCount,
            },
          });

          // Update group vote count
          await prisma.group.update({
            where: { id: targetGroup.id },
            data: {
              voteCount: {
                increment: voteCount,
              },
            },
          });

          return vote;
        }
      );

      const votes = await simulateConcurrentOperations(voteOperations);

      expect(votes).toHaveLength(participants.length);

      // Verify vote counts are correct
      const sessionState = await getSessionState(testSession.id);
      const totalVotesInDb = sessionState!.votes.reduce((sum, vote) => sum + vote.voteCount, 0);
      const totalVotesFromOperations = votes.reduce((sum, vote) => sum + vote.voteCount, 0);
      
      expect(totalVotesInDb).toBe(totalVotesFromOperations);

      // Verify group vote counts match individual votes
      const group1VoteCount = sessionState!.votes
        .filter(v => v.groupId === group1.id)
        .reduce((sum, vote) => sum + vote.voteCount, 0);
      const group2VoteCount = sessionState!.votes
        .filter(v => v.groupId === group2.id)
        .reduce((sum, vote) => sum + vote.voteCount, 0);

      const finalGroup1 = sessionState!.groups.find(g => g.id === group1.id)!;
      const finalGroup2 = sessionState!.groups.find(g => g.id === group2.id)!;

      expect(finalGroup1.voteCount).toBe(group1VoteCount);
      expect(finalGroup2.voteCount).toBe(group2VoteCount);
    });

    test('should prevent participants from exceeding vote limits during concurrent voting', async () => {
      // Create multiple groups to vote on
      const groups = await Promise.all([1, 2, 3, 4, 5].map(i => 
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

      // Each participant tries to vote on all groups simultaneously (should exceed limit)
      const participant = participants[0];
      
      const voteOperations = groups.map(group => 
        async () => {
          try {
            // Each vote uses 2 votes, total would be 10 (exceeds 4 limit)
            const vote = await prisma.vote.create({
              data: {
                id: uuidv4(),
                sessionId: testSession.id,
                participantId: participant.id,
                groupId: group.id,
                voteCount: 2,
              },
            });

            await prisma.group.update({
              where: { id: group.id },
              data: { voteCount: { increment: 2 } },
            });

            return vote;
          } catch (error) {
            // Expected to fail due to business logic validation
            return null;
          }
        }
      );

      const voteResults = await simulateConcurrentOperations(voteOperations);

      // Some votes should succeed, others might fail due to validation
      const successfulVotes = voteResults.filter(v => v !== null);
      
      // Verify total vote count doesn't exceed participant's limit
      const totalVoteCount = successfulVotes.reduce((sum, vote) => sum + (vote?.voteCount || 0), 0);
      expect(totalVoteCount).toBeLessThanOrEqual(4);
    });
  });

  describe('Concurrent Phase Transitions', () => {
    test('should handle concurrent phase change attempts gracefully', async () => {
      // Multiple host attempts to change phase (simulating network race conditions)
      const host = participants.find(p => p.isHost)!;
      
      const phaseChangeOperations = ['INPUT', 'GROUPING', 'VOTING'].map((targetPhase, index) => 
        () => prisma.session.update({
          where: { id: testSession.id },
          data: { phase: targetPhase as any },
        })
      );

      const results = await simulateConcurrentOperations(phaseChangeOperations, 10);

      expect(results).toHaveLength(3);

      // Verify session ended up in one of the target phases
      const finalSession = await prisma.session.findUnique({
        where: { id: testSession.id },
      });

      expect(['INPUT', 'GROUPING', 'VOTING']).toContain(finalSession!.phase);
    });

    test('should maintain data consistency during phase transitions', async () => {
      // Create responses while changing phases
      const responseOperations = participants.slice(0, 3).map(participant => 
        () => prisma.response.create({
          data: {
            id: uuidv4(),
            sessionId: testSession.id,
            participantId: participant.id,
            content: `Response during phase change from ${participant.displayName}`,
            category: 'WENT_WELL',
          },
        })
      );

      const phaseChangeOperations = [
        () => prisma.session.update({
          where: { id: testSession.id },
          data: { phase: 'INPUT' },
        }),
      ];

      // Execute both response creation and phase change concurrently
      const allOperations = [...responseOperations, ...phaseChangeOperations];
      await simulateConcurrentOperations(allOperations, 20);

      // Verify data consistency
      const sessionState = await getSessionState(testSession.id);
      
      expect(sessionState!.phase).toBe('INPUT');
      expect(sessionState!.responses.length).toBe(3);
      expect(sessionState!.participants.length).toBe(participants.length);
    });
  });

  describe('Connection and Session Management', () => {
    test('should handle multiple participants joining simultaneously', async () => {
      // Create a new session for join testing
      const joinTestSession = await prisma.session.create({
        data: {
          id: uuidv4(),
          title: 'Join Test Session',
          inviteCode: 'TEST',
          phase: 'SETUP',
        },
      });

      // Simulate multiple users trying to join simultaneously
      const joinOperations = Array.from({ length: 8 }, (_, index) => 
        () => prisma.participant.create({
          data: {
            id: uuidv4(),
            sessionId: joinTestSession.id,
            displayName: `ConcurrentUser${index + 1}`,
            avatarId: '🦁',
            isHost: index === 0, // First one becomes host
            socketId: `socket_concurrent_${index}`,
          },
        })
      );

      const joinedParticipants = await simulateConcurrentOperations(joinOperations);

      expect(joinedParticipants).toHaveLength(8);

      // Verify only one host
      const hosts = joinedParticipants.filter(p => p.isHost);
      expect(hosts).toHaveLength(1);

      // Verify all participants are in the session
      const sessionState = await getSessionState(joinTestSession.id);
      expect(sessionState!.participants).toHaveLength(8);
    });

    test('should handle concurrent participant disconnections', async () => {
      // Simulate multiple participants disconnecting simultaneously
      const participantsToDisconnect = participants.slice(0, 3);
      
      const disconnectOperations = participantsToDisconnect.map(participant => 
        () => prisma.participant.update({
          where: { id: participant.id },
          data: { 
            socketId: null,
            isActive: false,
            lastActiveAt: new Date(),
          },
        })
      );

      await simulateConcurrentOperations(disconnectOperations);

      const sessionState = await getSessionState(testSession.id);
      const inactiveParticipants = sessionState!.participants.filter(p => !p.isActive);
      
      expect(inactiveParticipants).toHaveLength(3);
    });
  });

  describe('Data Race Conditions', () => {
    test('should handle concurrent response position updates (drag operations)', async () => {
      // Create responses first
      const responses = await Promise.all(
        participants.slice(0, 4).map(participant => 
          prisma.response.create({
            data: {
              id: uuidv4(),
              sessionId: testSession.id,
              participantId: participant.id,
              content: `Draggable response from ${participant.displayName}`,
              category: 'WENT_WELL',
              positionX: 100,
              positionY: 100,
            },
          })
        )
      );

      // Multiple users try to move the same response simultaneously
      const targetResponse = responses[0];
      
      const dragOperations = participants.slice(0, 4).map((_, index) => 
        () => prisma.response.update({
          where: { id: targetResponse.id },
          data: {
            positionX: 200 + (index * 10),
            positionY: 200 + (index * 10),
          },
        })
      );

      const dragResults = await simulateConcurrentOperations(dragOperations, 30);

      expect(dragResults).toHaveLength(4);

      // Verify the response ended up in one of the target positions
      const finalResponse = await prisma.response.findUnique({
        where: { id: targetResponse.id },
      });

      expect(finalResponse!.positionX).toBeGreaterThanOrEqual(200);
      expect(finalResponse!.positionY).toBeGreaterThanOrEqual(200);
    });

    test('should handle concurrent group membership changes', async () => {
      // Create response and groups
      const response = await prisma.response.create({
        data: {
          id: uuidv4(),
          sessionId: testSession.id,
          participantId: participants[0].id,
          content: 'Response for group membership test',
          category: 'WENT_WELL',
        },
      });

      const groups = await Promise.all([1, 2, 3].map(i => 
        prisma.group.create({
          data: {
            id: uuidv4(),
            sessionId: testSession.id,
            label: `Target Group ${i}`,
            color: '#10b981',
            positionX: i * 100,
            positionY: 100,
            voteCount: 0,
          },
        })
      ));

      // Multiple operations try to assign response to different groups
      const assignmentOperations = groups.map(group => 
        () => prisma.response.update({
          where: { id: response.id },
          data: { groupId: group.id },
        })
      );

      const assignmentResults = await simulateConcurrentOperations(assignmentOperations, 25);

      expect(assignmentResults).toHaveLength(3);

      // Verify response is assigned to exactly one group
      const finalResponse = await prisma.response.findUnique({
        where: { id: response.id },
      });

      expect(finalResponse!.groupId).toBeDefined();
      expect(groups.map(g => g.id)).toContain(finalResponse!.groupId);
    });
  });

  describe('Performance Under Load', () => {
    test('should maintain performance with high concurrent operations', async () => {
      const startTime = Date.now();

      // Create a large number of concurrent operations
      const allOperations = [];

      // Response creation operations
      for (let i = 0; i < 20; i++) {
        allOperations.push(() => prisma.response.create({
          data: {
            id: uuidv4(),
            sessionId: testSession.id,
            participantId: participants[i % participants.length].id,
            content: `Load test response ${i}`,
            category: i % 2 === 0 ? 'WENT_WELL' : 'DIDNT_GO_WELL',
            positionX: Math.random() * 800,
            positionY: Math.random() * 600,
          },
        }));
      }

      // Group creation operations
      for (let i = 0; i < 5; i++) {
        allOperations.push(() => prisma.group.create({
          data: {
            id: uuidv4(),
            sessionId: testSession.id,
            label: `Load test group ${i}`,
            color: '#10b981',
            positionX: i * 100,
            positionY: 100,
            voteCount: 0,
          },
        }));
      }

      await simulateConcurrentOperations(allOperations);

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(3000); // Should complete within 3 seconds

      // Verify all operations completed successfully
      const sessionState = await getSessionState(testSession.id);
      expect(sessionState!.responses.length).toBe(20);
      expect(sessionState!.groups.length).toBe(5);
    });
  });
});