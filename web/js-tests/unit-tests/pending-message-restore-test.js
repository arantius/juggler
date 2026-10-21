//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What happens to a message the worker refused.
 *
 * A send clears the box before the worker has accepted anything, so the only
 * copy of what the user wrote is the pending message the conversation holds.
 * Two things can happen to it: the client re-broadcasts its model config and
 * resends it once (the missing-model self-heal), or it goes back into the box for the
 * user to act on. Both must carry the WHOLE message — a message is its text and
 * its image attachments together — because nothing else holds the images by
 * then: the box was cleared, no item was written (the worker bounces a
 * `no-model` send before it appends anything), and the asset bytes stay alive
 * only while something references them, a persisted draft included.
 *
 * These drive the three methods that own it against stubs, the way
 * message-history-test drives Session.addMessageToHistory: the surface each one
 * touches is two or three fields, and the world a real Conversation needs is
 * irrelevant to every assertion here.
 * @module unit-tests/pending-message-restore-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import Conversation from '../../js/model/conversation.js';
import SessionEvents from '../../js/model/session-events.js';
import workerManager from '../../js/services/worker-manager.js';
import '../../js/components/conversation-tab.js';

/** An uploaded image ref, as a staged attachment reaches the worker. */
const REF = { id: 'sha-pending-1', mime: 'image/png', filename: 'pixel.png', bytes: 12, width: 1, height: 1 };

/**
 * A stand-in for the composer that records what was put into it, through
 * either door — so the assertions are about what the box ends up holding
 * rather than about which method was called to put it there.
 * @returns {any} The fake composer.
 */
function fakeComposer() {
  return {
    text: '',
    /** @type {Array<any>} */
    attachments: [],
    restores: 0,
    /** @param {string} t */
    setText(t) { this.text = t; this.restores++; },
    /** @param {Array<any>} a */
    setPendingAttachments(a) { this.attachments = [...a]; },
    /** @param {{content?: string, attachments?: Array<any>}} m */
    restoreMessage({ content = '', attachments = [] } = {}) {
      this.text = content;
      this.attachments = [...attachments];
      this.restores++;
    }
  };
}

/**
 * A Conversation carrying only the fields these methods touch: real prototype
 * (so the methods call each other exactly as they do in production), own
 * properties for the two or three pieces of state involved, and none of the
 * world — doc, session — that plays no part in any assertion. Its worker link
 * is the page's manager, whose methods the cases swap.
 * @param {Record<string, any>} fields - The state this case needs.
 * @returns {any} The stand-in conversation.
 */
function makeConversation(fields) {
  return Object.assign(Object.create(Conversation.prototype), { _workerManager: workerManager }, fields);
}

/**
 * A session feed answered the way the tab showing the conversation answers
 * it, by the real tab handler, against a stand-in tab whose visible box is
 * `composer`. The conversation reaches its box only through this feed.
 * @param {any} composer - The fake composer the tab shows.
 * @returns {any} A `_session` carrying only the feed.
 */
function sessionShowing(composer) {
  const events = new SessionEvents(/** @type {any} */ ({}));
  const answer = /** @type {any} */ (customElements.get('conversation-tab')).prototype._answerModelRequest;
  events.subscribe((event) => answer.call({ getComposer: () => composer }, event));
  return { events };
}

/**
 * Run the pending-message restore test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // ── Test 1: a refused send hands the whole message back ──────────────────
  {
    try {
      const composer = fakeComposer();
      const conv = makeConversation({
        _pendingUserMessage: { content: 'look at this', attachments: [REF] },
        _session: sessionShowing(composer)
      });
      conv.restorePendingMessage();

      assert(composer.text === 'look at this',
        `the refused text must go back into the box, got ${JSON.stringify(composer.text)}`);
      assert(composer.attachments.length === 1 && composer.attachments[0].id === REF.id,
        `the refused message's image must go back with it, got ${JSON.stringify(composer.attachments)}`);
      assert(conv._pendingUserMessage === null,
        'the pending message must be consumed, so a second failure cannot restore it twice');
      passed++;
    } catch (e) {
      failed++;
      errors.push('restore-carries-the-whole-message: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Test 2: an image-only message is a message ───────────────────────────
  {
    try {
      const composer = fakeComposer();
      const conv = makeConversation({
        _pendingUserMessage: { content: '', attachments: [REF] },
        _session: sessionShowing(composer)
      });
      conv.restorePendingMessage();
      assert(composer.attachments.length === 1,
        `an image-only send has empty text, and must still be handed back, got ${JSON.stringify(composer.attachments)}`);

      // The other half of the same rule: nothing pending means nothing to do,
      // and the box (which the user may have typed into since) is left alone.
      const untouched = fakeComposer();
      const empty = makeConversation({
        _pendingUserMessage: { content: '   ', attachments: [] },
        _session: sessionShowing(untouched)
      });
      empty.restorePendingMessage();
      assert(untouched.restores === 0,
        `an empty pending message must not reach into the box, got ${untouched.restores} restore(s)`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('image-only-is-a-message: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Test 3: the self-heal resends the whole message, once ────────────────
  {
    try {
      /** @type {Array<any>} */
      const resends = [];
      const conv = makeConversation({
        _modelSelfHealAttempted: false,
        // The real `modelConfig` getter reads the root thread — this is a
        // client that HAS a model, which is the divergence being healed.
        _rootMessageThread: { modelConfig: { provider: 'test-co', model: 'test-1' } },
        _pendingUserMessage: { content: '', attachments: [REF] },
        resyncToWorker: () => resends.push('resync'),
        /**
         * @param {any} message - The message being resent.
         * @param {string|null} threadItemId - Target thread.
         * @returns {number} The recorded length, ignored.
         */
        resendToWorker: (message, threadItemId) => resends.push({ message, threadItemId })
      });

      const healed = conv.trySelfHealMissingModel('thread-1');
      assert(healed === true, 'an image-only send with a local model is self-healable');
      assert(resends[0] === 'resync', 'the config resync must ride ahead of the resend');
      assert(resends[1].message.attachments.length === 1 && resends[1].message.attachments[0].id === REF.id,
        `the resend must carry the images, got ${JSON.stringify(resends[1].message)}`);
      assert(resends[1].threadItemId === 'thread-1',
        `the resend must target the failed turn's thread, got ${JSON.stringify(resends[1].threadItemId)}`);

      // One shot: the latch it just set refuses a second attempt.
      assert(conv.trySelfHealMissingModel('thread-1') === false,
        'the self-heal is a one-shot — a second attempt must be refused');
      passed++;
    } catch (e) {
      failed++;
      errors.push('self-heal-resends-the-whole-message: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Test 4: what the resend actually puts on the wire ────────────────────
  {
    const realReady = workerManager.isWorkerReady;
    const realSend = workerManager.sendMessage;
    try {
      /** @type {Array<any>} */
      const sent = [];
      /** @type {any} */ (workerManager).isWorkerReady = () => true;
      /** @type {any} */ (workerManager).sendMessage = (/** @type {any[]} */ ...args) => sent.push(args);

      const conv = makeConversation({ id: 'conv-pending' });
      conv.resendToWorker({ content: 'look at this', attachments: [REF] }, 'thread-1');

      assert(sent.length === 1, `the resend must reach the worker once, got ${sent.length}`);
      const [convId, text, threadItemId, attachments] = sent[0];
      assert(convId === 'conv-pending' && text === 'look at this' && threadItemId === 'thread-1',
        `the resend must carry the message it was given, got ${JSON.stringify([convId, text, threadItemId])}`);
      assert(Array.isArray(attachments) && attachments.length === 1 && attachments[0].id === REF.id,
        `the resent message must still carry its attachment refs, got ${JSON.stringify(attachments)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('resend-puts-the-attachments-on-the-wire: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      /** @type {any} */ (workerManager).isWorkerReady = realReady;
      /** @type {any} */ (workerManager).sendMessage = realSend;
    }
  }

  // ── Test 5: an accepted turn retires the record for its own thread only ──
  // Once the worker has accepted the turn the message is in the transcript, and
  // the record has done its job. Left in place, a later refusal that never set
  // it — a Continue bounced for want of a model — would hand the old message
  // back, or resend it. A sibling thread's turn says nothing about this send,
  // which may still be waiting for its verdict, so it must not retire it.
  {
    try {
      const composer = fakeComposer();
      const conv = makeConversation({
        _pendingUserMessage: { content: 'sent already', attachments: [], threadItemId: 'thread-1' },
        _session: sessionShowing(composer)
      });
      conv.settlePendingMessage('thread-2');
      assert(conv._pendingUserMessage !== null,
        'a sibling thread\'s accepted turn must leave this send\'s record alone');
      conv.settlePendingMessage('thread-1');
      assert(conv._pendingUserMessage === null,
        'the accepted turn on the message\'s own thread must retire its record');
      conv.restorePendingMessage();
      assert(composer.restores === 0,
        `a retired record must not be handed back, got ${composer.restores} restore(s)`);

      const root = makeConversation({ _pendingUserMessage: { content: 'to root', attachments: [], threadItemId: null } });
      root.settlePendingMessage(null);
      assert(root._pendingUserMessage === null, 'the root thread is null on both sides, and matches');
      passed++;
    } catch (e) {
      failed++;
      errors.push('accepted-turn-retires-its-record: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Test 6: a validation notice warns, and hands back only a refused send ─
  // The notice arrives on the worker's status event, which names the thread
  // and the code. A refused send (`no-model`) is owed back; a turn that ran and
  // failed already holds the message in the transcript. The warning is the
  // user's language either way, the fallback included.
  {
    try {
      /** @type {string[]} */
      const warnings = [];
      let restores = 0;
      const conv = makeConversation({
        showWarning: (/** @type {string} */ text) => { warnings.push(text); },
        restorePendingMessage: () => { restores++; },
        trySelfHealMissingModel: () => false
      });
      const english = 'Please select a model before sending a message';
      await underPseudoLocale('pending-message-restore-test', async () => {
        conv.handleValidationNotice({ code: 'no-model', message: english, text: { key: english }, threadItemId: 'thread-1' });
        conv.handleValidationNotice({ code: 'provider-unavailable' });
      });
      assert(warnings.length === 2 && warnings.every((w) => isPseudoLocalized(w)),
        `both warnings must be translated, the fallback included: ${JSON.stringify(warnings)}`);
      assert(restores === 1, `only the refused send is handed back; got ${restores} restore(s)`);

      /** @type {Array<string|null>} */
      const healed = [];
      const healing = makeConversation({
        showWarning: () => { throw new Error('a healed refusal must not warn'); },
        restorePendingMessage: () => { throw new Error('a healed refusal must not hand the message back'); },
        trySelfHealMissingModel: (/** @type {string|null} */ id) => { healed.push(id); return true; }
      });
      healing.handleValidationNotice({ code: 'no-model', threadItemId: 'thread-1' });
      assert(healed.length === 1 && healed[0] === 'thread-1',
        `the self-heal must be tried for the refused thread, got ${JSON.stringify(healed)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('validation-notice: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  return { passed, failed, errors };
}
