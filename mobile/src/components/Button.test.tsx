import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { Button } from './Button';

describe('Button', () => {
  it('renders its label and calls onPress when tapped', () => {
    const onPress = jest.fn();
    render(<Button onPress={onPress}>Sign in</Button>);
    fireEvent.press(screen.getByText('Sign in'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not call onPress when disabled', () => {
    const onPress = jest.fn();
    render(
      <Button onPress={onPress} disabled>
        Sign in
      </Button>,
    );
    fireEvent.press(screen.getByText('Sign in'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('exposes accessibilityState.selected for the language-switcher pattern', () => {
    render(
      <Button onPress={() => undefined} selected testID="locale-th">
        ไทย
      </Button>,
    );
    expect(screen.getByTestId('locale-th').props.accessibilityState.selected).toBe(true);
  });
});
