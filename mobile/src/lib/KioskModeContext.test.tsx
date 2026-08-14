import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { KioskModeProvider, useKioskMode } from './KioskModeContext';

function Probe(): React.JSX.Element {
  const kiosk = useKioskMode();
  return (
    <>
      <Text testID="active">{String(kiosk.active)}</Text>
      <Text testID="enter" onPress={kiosk.enter}>
        enter
      </Text>
      <Text testID="exit-wrong" onPress={() => kiosk.exit('9999')}>
        exit-wrong
      </Text>
      <Text testID="exit-right" onPress={() => kiosk.exit('1234')}>
        exit-right
      </Text>
    </>
  );
}

describe('KioskModeContext', () => {
  it('starts inactive, enter() activates it', () => {
    render(
      <KioskModeProvider exitCode="1234">
        <Probe />
      </KioskModeProvider>,
    );
    expect(screen.getByTestId('active').props.children).toBe('false');
    fireEvent.press(screen.getByTestId('enter'));
    expect(screen.getByTestId('active').props.children).toBe('true');
  });

  it('exit() with the wrong code does nothing; the right code deactivates', () => {
    render(
      <KioskModeProvider exitCode="1234">
        <Probe />
      </KioskModeProvider>,
    );
    fireEvent.press(screen.getByTestId('enter'));
    fireEvent.press(screen.getByTestId('exit-wrong'));
    expect(screen.getByTestId('active').props.children).toBe('true');
    fireEvent.press(screen.getByTestId('exit-right'));
    expect(screen.getByTestId('active').props.children).toBe('false');
  });

  it('throws outside a provider (fail loud, not a silent no-op)', () => {
    function Bare() {
      useKioskMode();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/KioskModeProvider/);
  });
});
