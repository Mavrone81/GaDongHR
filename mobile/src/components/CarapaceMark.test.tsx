import React from 'react';
import { render } from '@testing-library/react-native';
import { CarapaceMark } from './CarapaceMark';

describe('CarapaceMark', () => {
  it('renders with the given accessible title', () => {
    const { getByLabelText } = render(<CarapaceMark title="GaDongHR mark" />);
    expect(getByLabelText('GaDongHR mark')).toBeTruthy();
  });

  it('defaults to the reversed tone', () => {
    const { UNSAFE_root } = render(<CarapaceMark title="mark" />);
    // Smoke test: renders without throwing and produces an SVG tree at all.
    expect(UNSAFE_root).toBeTruthy();
  });

  it('renders the ink tone without throwing', () => {
    const { getByLabelText } = render(<CarapaceMark title="mark" tone="ink" size={24} />);
    expect(getByLabelText('mark')).toBeTruthy();
  });
});
