import { prisma } from '../../src/utils/prisma';
import { v4 as uuidv4 } from 'uuid';
import { Phase } from '@prisma/client';

export interface TestSession {
  id: string;
  title: string;
  inviteCode: string;
  phase: Phase;
  participants: TestParticipant[];
}

export interface TestParticipant {
  id: string;
  sessionId: string;
  displayName: string;
  avatarId: string;
  isHost: boolean;
  socketId?: string;
}

export interface TestResponse {
  id: string;
  sessionId: string;
  participantId: string;
  content: string;
  category: 'WENT_WELL' | 'DIDNT_GO_WELL';
  positionX?: number;
  positionY?: number;
  groupId?: string;
}

export interface TestGroup {
  id: string;
  sessionId: string;
  label: string;
  color: string;
  positionX: number;
  positionY: number;
  voteCount: number;
}

export interface TestVote {
  id: string;
  sessionId: string;
  participantId: string;
  groupId: string;
  voteCount: number;
}

/**
 * Creates a test session with specified participants
 */
export async function createTestSession({
  title = 'Test Retrospective',
  phase = 'SETUP',
  participantCount = 3,
  withHost = true,
}: {
  title?: string;
  phase?: Phase;
  participantCount?: number;
  withHost?: boolean;
} = {}): Promise<TestSession> {
  const sessionId = uuidv4();
  const inviteCode = Math.random().toString(36).substr(2, 4).toUpperCase();

  // Create session
  const session = await prisma.session.create({
    data: {
      id: sessionId,
      title,
      inviteCode,
      phase,
    },
  });

  // Create participants
  const participants: TestParticipant[] = [];
  for (let i = 0; i < participantCount; i++) {
    const participantId = uuidv4();
    const participant = await prisma.participant.create({
      data: {
        id: participantId,
        sessionId,
        displayName: `TestUser${i + 1}`,
        avatarId: `🦁`, // Use a test avatar
        isHost: withHost && i === 0,
        socketId: `socket_${participantId}`,
      },
    });

    participants.push({
      id: participant.id,
      sessionId: participant.sessionId,
      displayName: participant.displayName,
      avatarId: participant.avatarId,
      isHost: participant.isHost,
      socketId: participant.socketId || undefined,
    });
  }

  return {
    id: session.id,
    title: session.title,
    inviteCode: session.inviteCode,
    phase: session.phase,
    participants,
  };
}

/**
 * Creates test responses for a session
 */
export async function createTestResponses(
  sessionId: string,
  participants: TestParticipant[],
  responsesPerParticipant = 2
): Promise<TestResponse[]> {
  const responses: TestResponse[] = [];

  for (const participant of participants) {
    for (let i = 0; i < responsesPerParticipant; i++) {
      const responseId = uuidv4();
      const category = i % 2 === 0 ? 'WENT_WELL' : 'DIDNT_GO_WELL';
      
      const response = await prisma.response.create({
        data: {
          id: responseId,
          sessionId,
          participantId: participant.id,
          content: `${participant.displayName} response ${i + 1}: ${category === 'WENT_WELL' ? 'Something good' : 'Something to improve'}`,
          category,
          positionX: Math.random() * 800,
          positionY: Math.random() * 600,
        },
      });

      responses.push({
        id: response.id,
        sessionId: response.sessionId,
        participantId: response.participantId,
        content: response.content,
        category: response.category as 'WENT_WELL' | 'DIDNT_GO_WELL',
        positionX: response.positionX || undefined,
        positionY: response.positionY || undefined,
        groupId: response.groupId || undefined,
      });
    }
  }

  return responses;
}

/**
 * Creates test groups with responses
 */
export async function createTestGroups(
  sessionId: string,
  responses: TestResponse[],
  groupCount = 2
): Promise<TestGroup[]> {
  const groups: TestGroup[] = [];

  // Divide responses into groups
  const responsesPerGroup = Math.ceil(responses.length / groupCount);
  
  for (let i = 0; i < groupCount; i++) {
    const groupId = uuidv4();
    const groupResponses = responses.slice(i * responsesPerGroup, (i + 1) * responsesPerGroup);
    
    if (groupResponses.length === 0) continue;

    const group = await prisma.group.create({
      data: {
        id: groupId,
        sessionId,
        label: `Test Group ${i + 1}`,
        color: groupResponses[0].category === 'WENT_WELL' ? '#10b981' : '#ef4444',
        positionX: 100 + (i * 200),
        positionY: 100 + (i * 150),
        voteCount: 0,
      },
    });

    // Assign responses to this group
    await prisma.response.updateMany({
      where: {
        id: { in: groupResponses.map(r => r.id) },
      },
      data: {
        groupId,
      },
    });

    groups.push({
      id: group.id,
      sessionId: group.sessionId,
      label: group.label,
      color: group.color,
      positionX: group.positionX,
      positionY: group.positionY,
      voteCount: group.voteCount,
    });
  }

  return groups;
}

/**
 * Creates test votes for groups
 */
export async function createTestVotes(
  sessionId: string,
  participants: TestParticipant[],
  groups: TestGroup[]
): Promise<TestVote[]> {
  const votes: TestVote[] = [];

  for (const participant of participants) {
    // Each participant gets 4 votes to distribute
    let remainingVotes = 4;
    
    for (const group of groups) {
      if (remainingVotes <= 0) break;
      
      const voteCount = Math.min(remainingVotes, Math.floor(Math.random() * 3) + 1);
      
      const vote = await prisma.vote.create({
        data: {
          id: uuidv4(),
          sessionId,
          participantId: participant.id,
          groupId: group.id,
          voteCount,
        },
      });

      // Update group vote count
      await prisma.group.update({
        where: { id: group.id },
        data: {
          voteCount: {
            increment: voteCount,
          },
        },
      });

      votes.push({
        id: vote.id,
        sessionId: vote.sessionId,
        participantId: vote.participantId,
        groupId: vote.groupId,
        voteCount: vote.voteCount,
      });

      remainingVotes -= voteCount;
    }
  }

  return votes;
}

/**
 * Simulates concurrent user operations
 */
export function simulateConcurrentOperations<T>(
  operations: (() => Promise<T>)[],
  delay = 0
): Promise<T[]> {
  return Promise.all(
    operations.map(async (op, index) => {
      // Add small random delay to simulate real-world timing
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay + Math.random() * delay));
      }
      return op();
    })
  );
}

/**
 * Waits for a condition to be true
 */
export function waitForCondition(
  condition: () => Promise<boolean> | boolean,
  timeout = 5000,
  interval = 100
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const check = async () => {
      try {
        if (await condition()) {
          resolve();
          return;
        }
        
        if (Date.now() - startTime > timeout) {
          reject(new Error(`Condition not met within ${timeout}ms`));
          return;
        }
        
        setTimeout(check, interval);
      } catch (error) {
        reject(error);
      }
    };
    
    check();
  });
}

/**
 * Gets the full session state including all related data
 */
export async function getSessionState(sessionId: string) {
  return await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      participants: true,
      responses: {
        include: {
          participant: true,
        },
      },
      groups: {
        include: {
          responses: {
            include: {
              participant: true,
            },
          },
        },
      },
      votes: true,
      connections: true,
    },
  });
}