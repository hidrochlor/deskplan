// Answers everything the receiver asks the page, and sends each question to the right part:
//   'put' / 'delete'        a task changed on the phone          -> ItemSync
//   'destinations'          which folders can the phone send to  -> every registered 'destination' provider
//   'destination-exists'    is this folder still there           -> the same providers
//   'pull'                  what changed on the PC since ...     -> ItemPull
//   'calendar'              lectures and exams in a time window  -> CalendarPull
//   'feed-courses'          which feed courses are hidden        -> the registered 'phoneFeedCourses' provider (feeds module)
// Each answer is { status, body } for the phone (see main/receiver/RendererItemGateway.js).
export class PhoneRequests {
  /** @param {{sync: {handle: Function}, registry: {list: Function}, pull?: {handle: Function}, calendar?: {handle: Function}}} o */
  constructor({ sync, registry, pull = null, calendar = null }) {
    this.sync = sync;
    this.registry = registry;
    this.pull = pull;
    this.calendar = calendar;
  }

  handle(request) {
    const providers = this.registry.list('destination');
    switch (request.op) {
      case 'destinations':
        return { status: 200, body: { destinations: providers.flatMap((p) => p.list()) } };
      case 'destination-exists':
        return { status: 200, body: { exists: typeof request.payload?.id === 'string' && providers.some((p) => p.has(request.payload.id)) } };
      case 'pull':
        return this.pull ? this.pull.handle(request.payload ?? {}) : { status: 404, body: { error: 'not-found' } };
      case 'calendar':
        return this.calendar ? this.calendar.handle(request.payload ?? {}) : { status: 404, body: { error: 'not-found' } };
      case 'feed-courses': {
        const courses = this.registry.list('phoneFeedCourses')[0];
        return courses ? courses.handle(request.payload ?? {}) : { status: 404, body: { error: 'not-found' } };
      }
      default:
        return this.sync.handle(request);
    }
  }
}
