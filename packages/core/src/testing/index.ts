export { FakeClient } from './fake-client.js';
export {
  FakeInteraction,
  fakeAutocomplete,
  fakeButton,
  fakeCommand,
  fakeModal,
  type FakeCommandInput,
  type FakeInteractionBase,
  type FakeResponse,
  type FakeResponseKind,
} from './interactions.js';
export { captureLog, type LogLine } from './log.js';

/** An interaction secret for module tests: `interactions: { secret: TEST_INTERACTION_SECRET }`. */
export const TEST_INTERACTION_SECRET = 'test-interaction-secret-0123456789abcdef';
export { fakeRest, type FakeRestAnswer, type RecordedRequest } from './rest.js';
