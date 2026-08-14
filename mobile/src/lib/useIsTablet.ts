import { useWindowDimensions } from 'react-native';

/**
 * 768px is the iPad mini's shortest-side point and the conventional
 * phone/tablet breakpoint (Apple's own Human Interface Guidelines and
 * Android's `sw600dp`/`sw720dp` size buckets both land in this range) —
 * used here to switch between phone-first single-pane screens and the
 * two-pane adaptive layouts the task brief asks for on iPad + Android
 * tablets (Leave, Payslip). Reads the CURRENT window, not the device model
 * — an iPad in narrow split-view gets the phone layout, which is the
 * correct behaviour (the content area really is phone-width), not a
 * device-detection heuristic.
 */
const TABLET_BREAKPOINT = 768;

export function useIsTablet(): boolean {
  const { width } = useWindowDimensions();
  return width >= TABLET_BREAKPOINT;
}
