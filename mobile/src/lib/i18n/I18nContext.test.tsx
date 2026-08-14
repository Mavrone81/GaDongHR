import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';

const mockFetchBundle = jest.fn();
jest.mock('../../api/svcI18n', () => ({ fetchBundle: (locale: string) => mockFetchBundle(locale) }));

import { I18nProvider, useI18n, createTranslator } from './I18nContext';

function Probe(): React.JSX.Element {
  const { t, locale, setLocale, ready } = useI18n();
  return (
    <>
      <Text testID="ready">{String(ready)}</Text>
      <Text testID="locale">{locale}</Text>
      <Text testID="translated">{t('auth.login.submit')}</Text>
      <Text testID="missing">{t('totally.missing.key')}</Text>
      <Text testID="interpolated">{t('auth.login.footer', { host: 'example.com' })}</Text>
      <Text testID="set-en" onPress={() => setLocale('en')}>
        set-en
      </Text>
    </>
  );
}

describe('I18nProvider', () => {
  beforeEach(() => {
    mockFetchBundle.mockReset();
  });

  it('starts on the Thai default and resolves ready once bundles settle', async () => {
    mockFetchBundle.mockResolvedValue({});
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale').props.children).toBe('th');
    await waitFor(() => expect(screen.getByTestId('ready').props.children).toBe('true'));
  });

  it('falls back to the bundled Thai translation when svc-i18n is unreachable', async () => {
    mockFetchBundle.mockRejectedValue(new Error('network down'));
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('ready').props.children).toBe('true'));
    expect(screen.getByTestId('translated').props.children).toBe('เข้าสู่ระบบ');
  });

  it('never renders an empty string for a missing key — falls back to the raw key', async () => {
    mockFetchBundle.mockResolvedValue({});
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('ready').props.children).toBe('true'));
    expect(screen.getByTestId('missing').props.children).toBe('totally.missing.key');
  });

  it('interpolates {vars} into the resolved template', async () => {
    mockFetchBundle.mockResolvedValue({});
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('ready').props.children).toBe('true'));
    expect(screen.getByTestId('interpolated').props.children).toContain('example.com');
  });

  it('setLocale switches the active locale and persists it', async () => {
    mockFetchBundle.mockResolvedValue({});
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('ready').props.children).toBe('true'));
    fireEvent.press(screen.getByTestId('set-en'));
    await waitFor(() => expect(screen.getByTestId('locale').props.children).toBe('en'));
  });
});

describe('createTranslator', () => {
  it('builds a t() from a plain bundle map with no provider needed', () => {
    const t = createTranslator({ 'a.b': 'Hello {name}' });
    expect(t('a.b', { name: 'World' })).toBe('Hello World');
    expect(t('missing')).toBe('missing');
  });
});
