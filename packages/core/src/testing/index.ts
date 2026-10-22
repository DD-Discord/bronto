export { FakeClient } from './fake-client.js';
export {
  FakeInteraction,
  fakeAutocomplete,
  fakeButton,
  fakeCommand,
  fakeModal,
  fakeSelect,
  type FakeCommandInput,
  type FakeInteractionBase,
  type FakeResponse,
  type FakeResponseKind,
  type UploadedFile,
} from './interactions.js';
export { captureLog, type LogLine } from './log.js';

/** An interaction secret for module tests: `interactions: { secret: TEST_INTERACTION_SECRET }`. */
export const TEST_INTERACTION_SECRET = 'test-interaction-secret-0123456789abcdef';
export { fakeRest, type FakeRestAnswer, type RecordedRequest } from './rest.js';

export { fakeTransport, type FakeHttpAnswer } from './rest.js';
export { FakeDiscordHttp } from './discord-http.js';
export { createNativeTestClient, type NativeTestClient } from './native-client.js';
