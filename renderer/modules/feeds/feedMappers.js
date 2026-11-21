// What one feed event means for DeskPlan. Each feed kind has its own mapper; map(entry) answers one of
//   { type: 'lecture' | 'exam' | 'event', title, context }       drawn on the calendar (FeedCalendarSource)
//   { type: 'deadline', title, course, semester, description }   becomes an assignment (AssignmentImporter)
//   { type: 'skip' }                                             ignored
// `entry` has the fields of a FeedEntry: summary, description, location, categories, start, end (ISO text).

const hasLength = (e) => !!e.end && Date.parse(e.end) > Date.parse(e.start);

/** "WS46a WS46a.02.212" -> "WS46a.02.212". Online / Asynchron stay as they are; "Ohne Ort" (no place) is empty. */
export function roomOf(location) {
  const parts = String(location ?? '').split(',').map((p) => p.trim()).filter((p) => p && p !== '. .');
  const last = parts.at(-1) ?? '';
  if (!last || /^ohne ort$/i.test(last)) return '';
  return last.split(/\s+/).at(-1);
}

// "Course (-84694) (Integrierte Lehrveranstaltung (IL)), Lecturer, Standardgruppe, . ., WS46a WS46a.02.212 (MET 2026)"
const LECTURE = /^(.*?) \((-\d+)\) \(([^()]*(?:\(([^()]*)\))?[^()]*)\),\s*([^,]*)/;
// "Prüfungstermin: M19.0592101 26W 2SSt VO Climate Change and Dynamics  bei Awan, -, , . ., WS46a WS46a.02.212 (MET 2026)"
const EXAM = /^Prüfungstermin:\s*/i;
const EXAM_PARTS = /^\S+\s+\S+\s+\S+\s+([A-Z]{2,3})\s+(.+?)\s+bei\s+([^,]*)/;

/** The FH JOANNEUM timetable (Stundenplan): lectures and exam dates. */
export const TimetableMapper = {
  map(e) {
    const room = roomOf(e.location);
    if (EXAM.test(e.summary)) {
      const rest = e.summary.replace(EXAM, '');
      const m = rest.match(EXAM_PARTS);
      const course = (m ? m[2] : rest.split(',')[0]).trim();
      return { type: 'exam', title: `Exam: ${course}`, course, context: join(room, m?.[3]) };
    }
    const m = e.summary.match(LECTURE);
    if (!m) return { type: 'lecture', title: e.summary.split(',')[0].trim() || 'Lecture', course: '', context: room };
    const [, course, , typeLong, typeShort, lecturer] = m;
    return { type: 'lecture', title: course.trim(), course: course.trim(), context: join(typeShort ?? typeLong, room, lecturer) };
  },
};

// Moodle ends a deadline's title with what happens then, in the course's language.
const DUE_SUFFIX = /\s+(?:ist fällig|is due|endet|ends|closes|schließt|fällig|due)\.?\s*$/i;
const OPENS_SUFFIX = /\s+(?:öffnet|opens|beginnt|starts)\.?\s*$/i;

/** "(MET_WS2026_1) Climate Change and Dynamics" -> { code: 'MET_WS2026_1', course: 'Climate Change and Dynamics' }. */
export function courseOf(categories) {
  const text = String(categories ?? '').trim();
  const m = text.match(/^\(([^)]+)\)\s*(.*)$/);
  return m ? { code: m[1], course: m[2].trim() } : { code: '', course: text };
}

/** "MET_WS2026_1" -> "WS 2026", "STM_SS2026_2" -> "SS 2026", anything else -> ''. */
export function semesterOf(code) {
  const m = String(code ?? '').match(/(?:^|[^A-Z])(WS|SS)[\s_-]?(\d{4})(?!\d)/i);
  return m ? `${m[1].toUpperCase()} ${m[2]}` : '';
}

/** Moodle: due dates (assignments, quizzes closing) become assignments; events with a length are shown as they are. */
export const MoodleMapper = {
  map(e) {
    const { code, course } = courseOf(e.categories);
    if (hasLength(e)) return { type: 'event', title: e.summary || 'Moodle event', context: course };
    if (OPENS_SUFFIX.test(e.summary)) return { type: 'skip' }; // "Quiz opens": not something to hand in
    const title = e.summary.replace(DUE_SUFFIX, '').trim() || 'Assignment';
    return { type: 'deadline', title, course, semester: semesterOf(code), description: e.description };
  },
};

/** Any other calendar: every event is shown on the calendar, nothing is imported. */
export const CalendarMapper = {
  map(e) {
    return { type: 'event', title: e.summary || 'Untitled', context: roomOf(e.location) || e.location };
  },
};

const MAPPERS = { timetable: TimetableMapper, moodle: MoodleMapper, calendar: CalendarMapper };

export function mapperFor(kind) {
  return MAPPERS[kind] ?? CalendarMapper;
}

function join(...parts) {
  return parts.map((p) => String(p ?? '').trim()).filter((p) => p && p !== '-').join(' · ');
}
