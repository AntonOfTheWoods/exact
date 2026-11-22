//! Caret timing uses the window's monotonic clock and the presenter's geometry.
use exact_painted::{paint::Rect4, Presenter};
use exact_runner::DataSource;
use std::time::Duration;

pub(super) struct Blink {
    timing: Option<(f64, f64)>,
    position: Option<Rect4>,
    activity: f64,
    visible: bool,
}

impl Blink {
    pub(super) fn new(timing: Option<(Duration, Duration)>) -> Self {
        Self {
            timing: timing
                .map(|(cycle, idle)| (cycle.as_secs_f64() * 500., idle.as_secs_f64() * 1000.)),
            position: None,
            activity: 0.,
            visible: true,
        }
    }

    pub(super) fn restart(&mut self, now: f64) {
        self.activity = now;
    }

    fn position(&mut self, position: Option<Rect4>, now: f64) {
        if self.position != position {
            self.position = position;
            self.restart(now);
        }
    }

    fn phase(&self, now: f64) -> (bool, Option<f64>) {
        let Some((half_cycle, timeout)) = self.timing.filter(|_| self.position.is_some()) else {
            return (true, None);
        };
        let elapsed = (now - self.activity).max(0.);
        if elapsed >= timeout {
            return (true, None);
        }
        let phase = (elapsed / half_cycle).floor();
        let due = self.activity + ((phase + 1.) * half_cycle).min(timeout);
        ((phase as u64).is_multiple_of(2), Some(due))
    }

    pub(super) fn deadline(&self, now: f64) -> Option<f64> {
        self.phase(now).1
    }

    pub(super) fn update<D: DataSource>(&mut self, presenter: &mut Presenter<D>, now: f64) {
        if self.timing.is_none() {
            return;
        }
        self.position(presenter.caret_frame(), now);
        let visible = self.phase(now).0;
        if std::mem::replace(&mut self.visible, visible) != visible {
            presenter.set_caret_visible(visible);
            presenter.repaint();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caret_blinks_while_focused_and_returns_to_steady_when_idle() {
        let mut blink = Blink::new(Some((Duration::from_millis(1200), Duration::from_secs(10))));
        assert_eq!(blink.phase(0.), (true, None));
        let position = Some((10., 10., 1., 20.));
        blink.position(position, 100.);
        assert_eq!(blink.phase(100.), (true, Some(700.)));
        assert_eq!(blink.phase(700.), (false, Some(1300.)));
        blink.restart(800.);
        assert_eq!(blink.phase(800.), (true, Some(1400.)));
        assert_eq!(blink.phase(10_500.), (true, Some(10_800.)));
        assert_eq!(blink.phase(10_800.), (true, None));
        blink.position(None, 10_900.);
        assert_eq!(blink.phase(11_500.), (true, None));

        let mut steady = Blink::new(None);
        steady.position(position, 100.);
        assert_eq!(steady.phase(700.), (true, None));
    }
}
