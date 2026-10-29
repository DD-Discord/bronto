import { randomBytes } from 'node:crypto';
import { CONFIRM_MS } from './limits.js';

export interface PendingMove {
  guildId: string;
  userId: string;
  sourceId: string;
  targetId: string;
  fromId: string;
  toId: string | null;
  /** The largest file in bytes the move may upload, taken from the command's interaction. */
  uploadLimit: number;
  createdAt: number;
}

/** Moves waiting for their confirmation, in memory; a restart turns them into expired ones. */
export class PendingMoves {
  private readonly moves = new Map<string, PendingMove>();

  /** Stores the move and returns the token its buttons carry. */
  create(move: PendingMove): string {
    this.sweep();
    const token = randomBytes(9).toString('base64url');
    this.moves.set(token, move);
    return token;
  }

  /** Removes and returns the move; null when the token is unknown, used or older than `CONFIRM_MS`. */
  take(token: string): PendingMove | null {
    const move = this.moves.get(token);
    this.moves.delete(token);
    return move !== undefined && Date.now() - move.createdAt <= CONFIRM_MS ? move : null;
  }

  /** Forgets the pending moves of a server. */
  clear(guildId: string): void {
    for (const [token, move] of this.moves) if (move.guildId === guildId) this.moves.delete(token);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, move] of this.moves) if (now - move.createdAt > CONFIRM_MS) this.moves.delete(token);
  }
}
