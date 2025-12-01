import { describe, test, expect, beforeEach } from '@jest/globals';
import { prisma } from '../../src/utils/prisma';
import {
  createTestSession,
  createTestResponses,
  createTestGroups,
  createTestVotes,
  getSessionState,
  simulateConcurrentOperations,
  TestSession,
  TestParticipant,
} from '../utils/testHelpers';
import { v4 as uuidv4 } from 'uuid';

describe('Session Workflows', () => {
  let testSession: TestSession;
  let host: TestParticipant;
  let participants: TestParticipant[];

  beforeEach(async () => {
    testSession = await createTestSession({
      title: 'Test Session Workflow',
      participantCount: 4,
      withHost: true,
    });
    
    host = testSession.participants.find(p => p.isHost)!;
    participants = testSession.participants.filter(p => !p.isHost);
  });

  describe('Session Creation and Management', () => {
    test('should create a session with unique invite code', async () => {
      const session1 = await createTestSession({ title: 'Session 1' });
      const session2 = await createTestSession({ title: 'Session 2' });

      expect(session1.inviteCode).not.toBe(session2.inviteCode);
      expect(session1.inviteCode).toHaveLength(4);
      expect(session2.inviteCode).toHaveLength(4);
      expect(session1.id).not.toBe(session2.id);
    });

    test('should handle session with maximum participants', async () => {
      const maxParticipants = 15;
      const session = await createTestSession({
        participantCount: maxParticipants,
      });

      expect(session.participants).toHaveLength(maxParticipants);
      
      // Verify only one host
      const hosts = session.participants.filter(p => p.isHost);
      expect(hosts).toHaveLength(1);
    });

    test('should find session by invite code', async () => {
      const session = await prisma.session.findUnique({
        where: { inviteCode: testSession.inviteCode },
      });

      expect(session).toBeDefined();
      expect(session!.id).toBe(testSession.id);
      expect(session!.title).toBe(testSession.title);
    });

    test('should update session phase', async () => {
      await prisma.session.update({
        where: { id: testSession.id },
        data: { phase: 'INPUT' },
      });

      const updatedSession = await prisma.session.findUnique({
        where: { id: testSession.id },
      });

      expect(updatedSession!.phase).toBe('INPUT');
    });
  });

  describe('Phase Transitions', () => {
    test('should follow proper phase sequence', async () => {
      const phases = ['SETUP', 'INPUT', 'GROUPING', 'VOTING', 'RESULTS'];
      
      for (let i = 0; i < phases.length; i++) {
        await prisma.session.update({
          where: { id: testSession.id },
          data: { phase: phases[i] as any },
        });

        const session = await prisma.session.findUnique({
          where: { id: testSession.id },
        });

        expect(session!.phase).toBe(phases[i]);
      }
    });

    test('should maintain session state during phase transitions', async () => {
      // Create some responses
      const responses = await createTestResponses(testSession.id, testSession.participants, 2);
      
      // Transition through phases
      await prisma.session.update({
        where: { id: testSession.id },
        data: { phase: 'INPUT' },
      });

      await prisma.session.update({
        where: { id: testSession.id },
        data: { phase: 'GROUPING' },
      });

      // Verify responses are still there
      const sessionState = await getSessionState(testSession.id);
      expect(sessionState!.responses).toHaveLength(responses.length);
      expect(sessionState!.participants).toHaveLength(testSession.participants.length);
    });
  });

  describe('Participant Management', () => {
    test('should handle participant joining mid-session', async () => {
      const newParticipantId = uuidv4();
      
      const newParticipant = await prisma.participant.create({
        data: {
          id: newParticipantId,
          sessionId: testSession.id,
          displayName: 'LateJoiner',
          avatarId: '🐺',
          isHost: false,
          socketId: `socket_${newParticipantId}`,
        },
      });

      const sessionState = await getSessionState(testSession.id);
      expect(sessionState!.participants).toHaveLength(testSession.participants.length + 1);
      
      const addedParticipant = sessionState!.participants.find(p => p.id === newParticipantId);
      expect(addedParticipant).toBeDefined();
      expect(addedParticipant!.displayName).toBe('LateJoiner');
      expect(addedParticipant!.isHost).toBe(false);
    });

    test('should handle host leaving and reassigning host privileges', async () => {
      // Remove current host
      await prisma.participant.delete({
        where: { id: host.id },
      });

      // Reassign host to next participant
      const nextHost = participants[0];
      await prisma.participant.update({
        where: { id: nextHost.id },
        data: { isHost: true },
      });

      const sessionState = await getSessionState(testSession.id);
      const hosts = sessionState!.participants.filter(p => p.isHost);
      
      expect(hosts).toHaveLength(1);
      expect(hosts[0].id).toBe(nextHost.id);
      expect(sessionState!.participants).toHaveLength(testSession.participants.length - 1);
    });

    test('should handle participant avatar conflicts', async () => {
      const existingAvatars = testSession.participants.map(p => p.avatarId);
      const availableAvatars = ['🦁', '🐯', '🦊', '🐺', '🐙', '🦈', '🤖', '🦅'];
      const unusedAvatar = availableAvatars.find(avatar => !existingAvatars.includes(avatar));

      if (unusedAvatar) {
        const newParticipantId = uuidv4();
        
        const newParticipant = await prisma.participant.create({
          data: {
            id: newParticipantId,
            sessionId: testSession.id,
            displayName: 'NewUser',
            avatarId: unusedAvatar,
            isHost: false,
          },
        });

        expect(newParticipant.avatarId).toBe(unusedAvatar);
      }
    });
  });

  describe('Response Management', () => {
    test('should create responses for all participants', async () => {
      const responses = await createTestResponses(testSession.id, testSession.participants, 3);
      
      expect(responses).toHaveLength(testSession.participants.length * 3);
      
      // Verify each participant has responses
      for (const participant of testSession.participants) {
        const participantResponses = responses.filter(r => r.participantId === participant.id);
        expect(participantResponses).toHaveLength(3);
      }
    });

    test('should handle response updates', async () => {
      const responses = await createTestResponses(testSession.id, testSession.participants, 1);
      const response = responses[0];

      const updatedContent = 'Updated response content';
      await prisma.response.update({
        where: { id: response.id },
        data: { content: updatedContent },
      });

      const updatedResponse = await prisma.response.findUnique({
        where: { id: response.id },
      });

      expect(updatedResponse!.content).toBe(updatedContent);
    });

    test('should handle response deletion', async () => {
      const responses = await createTestResponses(testSession.id, testSession.participants, 2);
      const responseToDelete = responses[0];

      await prisma.response.delete({
        where: { id: responseToDelete.id },
      });

      const remainingResponses = await prisma.response.findMany({
        where: { sessionId: testSession.id },
      });

      expect(remainingResponses).toHaveLength(responses.length - 1);
      expect(remainingResponses.find(r => r.id === responseToDelete.id)).toBeUndefined();
    });
  });

  describe('Grouping and Voting Workflows', () => {
    test('should create groups and assign responses', async () => {
      const responses = await createTestResponses(testSession.id, testSession.participants, 2);
      const groups = await createTestGroups(testSession.id, responses, 2);

      expect(groups).toHaveLength(2);

      const sessionState = await getSessionState(testSession.id);
      
      // Verify all responses are assigned to groups
      const groupedResponses = sessionState!.responses.filter(r => r.groupId !== null);
      expect(groupedResponses).toHaveLength(responses.length);

      // Verify groups have correct response counts
      for (const group of groups) {
        const groupResponses = sessionState!.responses.filter(r => r.groupId === group.id);
        expect(groupResponses.length).toBeGreaterThan(0);
      }
    });

    test('should handle voting on groups', async () => {
      const responses = await createTestResponses(testSession.id, testSession.participants, 2);
      const groups = await createTestGroups(testSession.id, responses, 2);
      const votes = await createTestVotes(testSession.id, testSession.participants, groups);

      expect(votes.length).toBeGreaterThan(0);

      const sessionState = await getSessionState(testSession.id);
      
      // Verify vote counts are aggregated correctly
      const totalVoteCount = votes.reduce((sum, vote) => sum + vote.voteCount, 0);
      const groupVoteCount = sessionState!.groups.reduce((sum, group) => sum + group.voteCount, 0);
      
      expect(groupVoteCount).toBe(totalVoteCount);

      // Verify each participant doesn't exceed 4 votes
      for (const participant of testSession.participants) {
        const participantVotes = votes.filter(v => v.participantId === participant.id);
        const totalParticipantVotes = participantVotes.reduce((sum, vote) => sum + vote.voteCount, 0);
        expect(totalParticipantVotes).toBeLessThanOrEqual(4);
      }
    });

    test('should prevent duplicate voting on same group by same participant', async () => {
      const responses = await createTestResponses(testSession.id, testSession.participants, 1);
      const groups = await createTestGroups(testSession.id, responses, 1);
      const group = groups[0];
      const participant = testSession.participants[0];

      // Create first vote
      await prisma.vote.create({
        data: {
          id: uuidv4(),
          sessionId: testSession.id,
          participantId: participant.id,
          groupId: group.id,
          voteCount: 2,
        },
      });

      // Try to create duplicate vote - should fail due to unique constraint
      await expect(prisma.vote.create({
        data: {
          id: uuidv4(),
          sessionId: testSession.id,
          participantId: participant.id,
          groupId: group.id,
          voteCount: 1,
        },
      })).rejects.toThrow();
    });
  });

  describe('Data Integrity', () => {
    test('should maintain referential integrity on participant deletion', async () => {
      const responses = await createTestResponses(testSession.id, [participants[0]], 2);
      const participantToDelete = participants[0];

      // Delete participant
      await prisma.participant.delete({
        where: { id: participantToDelete.id },
      });

      // Verify responses are also deleted (cascade)
      const remainingResponses = await prisma.response.findMany({
        where: { participantId: participantToDelete.id },
      });

      expect(remainingResponses).toHaveLength(0);
    });

    test('should maintain referential integrity on session deletion', async () => {
      const sessionToDelete = await createTestSession({
        title: 'Session to Delete',
        participantCount: 2,
      });

      await createTestResponses(sessionToDelete.id, sessionToDelete.participants, 1);

      // Delete session
      await prisma.session.delete({
        where: { id: sessionToDelete.id },
      });

      // Verify all related data is deleted
      const remainingParticipants = await prisma.participant.findMany({
        where: { sessionId: sessionToDelete.id },
      });
      const remainingResponses = await prisma.response.findMany({
        where: { sessionId: sessionToDelete.id },
      });

      expect(remainingParticipants).toHaveLength(0);
      expect(remainingResponses).toHaveLength(0);
    });
  });

  describe('Performance and Scalability', () => {
    test('should handle large number of responses efficiently', async () => {
      const largeSession = await createTestSession({
        participantCount: 10,
      });

      const startTime = Date.now();
      await createTestResponses(largeSession.id, largeSession.participants, 5);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(2000); // Should complete within 2 seconds

      const sessionState = await getSessionState(largeSession.id);
      expect(sessionState!.responses).toHaveLength(50); // 10 participants × 5 responses
    });

    test('should handle complex group and voting scenarios', async () => {
      const complexSession = await createTestSession({
        participantCount: 8,
      });

      const responses = await createTestResponses(complexSession.id, complexSession.participants, 3);
      const groups = await createTestGroups(complexSession.id, responses, 4);
      const votes = await createTestVotes(complexSession.id, complexSession.participants, groups);

      expect(responses).toHaveLength(24); // 8 × 3
      expect(groups).toHaveLength(4);
      expect(votes.length).toBeGreaterThan(0);

      const sessionState = await getSessionState(complexSession.id);
      expect(sessionState!.participants).toHaveLength(8);
      expect(sessionState!.responses).toHaveLength(24);
      expect(sessionState!.groups).toHaveLength(4);
    });
  });
});