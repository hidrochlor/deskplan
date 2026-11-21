import { FeatureModule } from '../../core/FeatureModule.js';
import { CalendarView } from './CalendarView.js';

// Month calendar. It owns no data: it draws deadlines from every registered
// calendar source (today: anything on the Home canvas that has a deadline).
export class CalendarModule extends FeatureModule {
  constructor() { super('calendar'); }

  install({ registry }) {
    registry.register('view', { id: 'calendar', label: 'Calendar', icon: 'calendar', create: (ctx) => new CalendarView(ctx) }, 30);
  }
}
