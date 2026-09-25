// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { isDraftSessionExpired } from "./entity-draft-contract";
import type {
  EntityDraft, DraftCreate, DraftSave, DraftApply, DraftApplied,
} from "./entity-draft-contract";
import type { KinClient } from "./kin-client";

/** Editor recovery hints. Only a daemon acknowledgement makes text saved. */
export interface DraftJournal {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export type DraftTransport = Pick<KinClient,
  "createDraft" | "saveDraft" | "readDraft" | "applyDraft" | "registerDraftSession"
>;

const keyFor = (scope: string, operation: string) => `kin.draft.v1.${scope}.${operation}`;

/** Persist the invocation before dispatch so a reload cannot change its identity. */
export async function createEntityDraft(
  client: DraftTransport,
  journal: DraftJournal,
  scope: string,
  source: Omit<DraftCreate, "draft_id">,
  assertCurrent: () => void = () => undefined,
): Promise<EntityDraft> {
  const key = keyFor(scope, "create");
  const request = journal.get<DraftCreate>(key) ?? { ...source, draft_id: randomUUID() };
  await journal.update(key, request);
  assertCurrent();
  const draft = await client.createDraft(request);
  await journal.update(key, undefined);
  return draft;
}

/**
 * One editor's acknowledged revision. A concurrent editor never advances this
 * expectation merely by saving. The daemon owns revision CAS and publication.
 */
export class EntityDraftSession {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    public draft: EntityDraft,
    private client: DraftTransport,
    private readonly journal: DraftJournal,
    private readonly scope: string,
    private assertCurrent: () => void = () => undefined,
  ) {}

  /** Reconnect to immutable history without adopting another editor's latest CAS. */
  rebind(client: DraftTransport, assertCurrent: () => void): Promise<void> {
    return this.serialize(async () => {
      assertCurrent();
      const retained = await client.readDraft(this.draft.draft_id, this.draft.revision);
      assertCurrent();
      if (!isDeepStrictEqual(retained, this.draft)) {
        throw new Error("The reopened workspace does not contain this draft's exact saved identity and revision. Keep this buffer; no Save or Apply was sent.");
      }
      this.client = client;
      this.assertCurrent = assertCurrent;
    });
  }

  private transport(): DraftTransport { this.assertCurrent(); return this.client; }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  save(body: string): Promise<EntityDraft> {
    return this.serialize(async () => {
      const key = keyFor(this.scope, "save");
      const pending = this.journal.get<DraftSave>(key);
      if (pending) {
        // Recover the previous exact request before submitting newer buffer text.
        this.draft = await this.transport().saveDraft(pending);
        await this.journal.update(key, undefined);
      }
      this.assertCurrent();
      if (body === this.draft.body) return this.draft;
      const request: DraftSave = {
        draft_id: this.draft.draft_id,
        expected_revision: this.draft.revision,
        body,
      };
      await this.journal.update(key, request);
      const saved = await this.transport().saveDraft(request);
      this.draft = saved;
      await this.journal.update(key, undefined);
      return saved;
    });
  }

  apply(): Promise<DraftApplied> {
    return this.serialize(() => this.applySaved(false));
  }

  /** Try receipt recovery before considering registration of the original session. */
  resumeApply(): Promise<DraftApplied> {
    return this.serialize(() => this.applySaved(true));
  }

  private async applySaved(resume: boolean): Promise<DraftApplied> {
    this.assertCurrent();
    const key = keyFor(this.scope, "apply");
    let request = this.journal.get<DraftApply>(key);
    if (!request) {
      const pending = this.draft.pending_apply;
      if (resume && !pending) throw new Error("No interrupted Apply is recorded for this draft.");
      if (!pending && this.draft.applied_receipt?.attempt.draft_revision === this.draft.content_revision) {
        throw new Error("This saved revision already has an Apply receipt. Open current source to start another draft; replay does not prove those bytes are still current.");
      }
      request = {
        draft_id: this.draft.draft_id,
        expected_revision: pending?.requested_revision ?? this.draft.revision,
        session_id: pending?.session_id ?? randomUUID(),
      };
      await this.journal.update(key, request);
      if (!pending) await this.transport().registerDraftSession(request.session_id);
    }
    try {
      let applied: DraftApplied;
      try { applied = await this.transport().applyDraft(request); }
      catch (error) {
        if (!resume || !isDraftSessionExpired(error)) throw error;
        await this.transport().registerDraftSession(request.session_id);
        applied = await this.transport().applyDraft(request);
      }
      this.acceptMetadata(applied.draft);
      await this.journal.update(key, undefined);
      return applied;
    } catch (error) {
      // Apply may have durably appended its attempt before refusing. Preserve
      // that CAS revision only when it still describes this editor's text.
      try { this.acceptMetadata(await this.transport().readDraft(this.draft.draft_id)); } catch { /* Retain the last acknowledgement. */ }
      throw error;
    }
  }

  private acceptMetadata(latest: EntityDraft): void {
    if (latest.draft_id === this.draft.draft_id && latest.body === this.draft.body &&
        latest.content_revision === this.draft.content_revision && latest.revision >= this.draft.revision) {
      this.draft = latest;
    }
  }
}
