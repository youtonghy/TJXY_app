import { clientRequest, type ClientSession } from './http';

export interface QrChallenge {
  ChallengeId: string;
  PollToken: string;
  QrPayload: string;
  ExpiresAt: string;
}

export interface QrAuthentication {
  User: { Id: string; Name: string };
  SessionInfo: { Id: string };
  AccessToken: string;
}

export interface QrPollResult {
  State: 'Pending' | 'Approved';
  ExpiresAt: string;
  Authentication?: QrAuthentication;
}

export interface QrApprovalPreview {
  ChallengeId: string;
  DeviceName: string;
  ClientName: string;
  ApplicationVersion: string;
  ExpiresAt: string;
}

export interface PersonalSession {
  Id: string;
  DeviceId: string;
  DeviceName: string;
  ClientName: string;
  ApplicationVersion: string;
  CreatedAt: string;
  LastActivityDate: string;
  IsCurrent: boolean;
}

export function createQrChallenge(session: ClientSession): Promise<QrChallenge> {
  return clientRequest<QrChallenge>(session, '/Auth/Qr/Challenges', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function pollQrChallenge(
  session: ClientSession,
  challengeId: string,
  pollToken: string,
  signal?: AbortSignal,
): Promise<QrPollResult> {
  return clientRequest<QrPollResult>(session, `/Auth/Qr/Challenges/${encodeURIComponent(challengeId)}/Poll`, {
    method: 'POST',
    body: JSON.stringify({ Token: pollToken }),
    signal,
  });
}

export function previewQrApproval(session: ClientSession, approvalToken: string): Promise<QrApprovalPreview> {
  return clientRequest<QrApprovalPreview>(session, '/Auth/Qr/Preview', {
    method: 'POST',
    body: JSON.stringify({ Token: approvalToken }),
  });
}

export function approveQrLogin(session: ClientSession, approvalToken: string): Promise<void> {
  return clientRequest<void>(session, '/Auth/Qr/Approve', {
    method: 'POST',
    body: JSON.stringify({ Token: approvalToken }),
  });
}

export function listPersonalSessions(session: ClientSession): Promise<PersonalSession[]> {
  return clientRequest<PersonalSession[]>(session, '/Users/Me/Sessions');
}

export function revokePersonalSession(session: ClientSession, sessionId: string): Promise<void> {
  return clientRequest<void>(session, `/Users/Me/Sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

export function approvalTokenFromQrPayload(value: string): string | null {
  const match = /^tjxy-login:v1:[^:]+:(.+)$/u.exec(value.trim());
  return match?.[1] ?? null;
}
