import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { RuleRow } from './RuleRow';

describe('RuleRow', () => {
  it('renders a string label and value', () => {
    render(<RuleRow label="Net pay" value="฿22,986.75" />);
    expect(screen.getByText('Net pay')).toBeTruthy();
    expect(screen.getByText('฿22,986.75')).toBeTruthy();
  });

  it('accepts a node value/label (e.g. a DateText) without wrapping it in an extra Text', () => {
    render(<RuleRow label={<Text>Custom label</Text>} value={<Text testID="custom-value">custom</Text>} />);
    expect(screen.getByText('Custom label')).toBeTruthy();
    expect(screen.getByTestId('custom-value')).toBeTruthy();
  });
});
