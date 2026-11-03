import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Weather widget (Sep 29): my location or a picked city, a forecast that
// renders, and a graceful path when the browser refuses location.

const weather = vi.fn();
const weatherPlaces = vi.fn();
const weatherPlaceName = vi.fn();
const getConstructionProjects = vi.fn();
vi.mock('../api', () => ({
  api: {
    weather: (...a) => weather(...a),
    weatherPlaces: (...a) => weatherPlaces(...a),
    weatherPlaceName: (...a) => weatherPlaceName(...a),
    getConstructionProjects: (...a) => getConstructionProjects(...a),
  },
}));

const { default: WeatherWidget, WeatherConfigFields } = await import('./weatherWidget.jsx');
const { weatherConfigValid, sky } = await import('./weatherLib');

const FORECAST = {
  units: { temp: '°F', wind: 'mph', precip: 'in' },
  current: { temp: 66.9, feelsLike: 69.2, humidity: 81, isDay: true, code: 2, wind: 3.2, windDir: 304 },
  today: { high: 82.2, low: 63, precipChance: 26, uvMax: 6.8, sunrise: '2026-09-28T06:40', sunset: '2026-09-28T18:36' },
  hourly: [{ time: '2026-09-28T14:00', temp: 80, code: 1, isDay: true, precipChance: 0 },
           { time: '2026-09-28T15:00', temp: 81, code: 61, isDay: true, precipChance: 40 }],
  daily: [{ date: '2026-09-28', high: 82, low: 63, code: 2, precipChance: 26 }],
  fetchedAt: '2026-09-28T21:00:00Z',
};

function geolocation(result) {
  Object.defineProperty(global.navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: (ok, fail) => (result.error ? fail({ code: result.error }) : ok({ coords: result })) },
  });
}

beforeEach(() => {
  localStorage.clear();
  weather.mockReset().mockResolvedValue(FORECAST);
  weatherPlaces.mockReset().mockResolvedValue({ places: [{ name: 'Pune', region: 'Maharashtra', country: 'India', countryCode: 'IN', lat: 18.52, lon: 73.86 }] });
  weatherPlaceName.mockReset().mockResolvedValue({ name: 'Escondido, CA' });
  getConstructionProjects.mockReset().mockResolvedValue([
    { id: 'p1', name: 'GS Temecula', address: '41000 Main St, Temecula, CA', latitude: 33.49, longitude: -117.15, status: 'active' },
    { id: 'p2', name: 'No Point Yet', address: 'Somewhere', latitude: 0, longitude: 0, status: 'active' },
    { id: 'p3', name: 'Done', address: 'Old', latitude: 1, longitude: 1, status: 'complete' },
  ]);
});
afterEach(() => { delete global.navigator.geolocation; });

describe('Weather widget', () => {
  it('shows the weather where I am, named', async () => {
    geolocation({ latitude: 33.12, longitude: -117.09 });
    render(<WeatherWidget config={{ mode: 'here' }} />);
    expect(await screen.findByText('67°')).toBeTruthy();
    expect(screen.getByText('Partly Cloudy')).toBeTruthy();
    expect(screen.getByText(/Feels like 69°/)).toBeTruthy();
    expect(await screen.findByText('Escondido, CA')).toBeTruthy();
    expect(weather).toHaveBeenCalledWith(33.12, -117.09, 'imperial');
    expect(screen.getByLabelText('Hourly').textContent).toContain('Now');
    // The face says when the rain starts (the 3 PM hour is rain at 40%).
    expect(screen.getByLabelText('Rain').textContent).toContain('Rain from 3 PM · 40%');
  });

  it('opens the Forecast popup: today hour by hour, then the next days (Neil, 10/30/2026)', async () => {
    geolocation({ latitude: 33.12, longitude: -117.09 });
    render(<WeatherWidget config={{ mode: 'here' }} />);
    await screen.findByText('67°');
    expect(screen.queryByText(/Next 1 Days/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Weather/ }));
    expect(await screen.findByText('Today, Hour By Hour')).toBeTruthy();
    expect(screen.getByLabelText('Today, hour by hour').textContent).toContain('3 PM');
    expect(screen.getByLabelText('Next 10 Days').textContent).toContain('Today');
    expect(screen.getByLabelText('Next 10 Days').textContent).toContain('26%');
    // Refresh on the tile is still a refresh, not a second popup.
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByText('Today, Hour By Hour')).toBeNull();
    fireEvent.click(screen.getByLabelText('Refresh weather'));
    expect(screen.queryByText('Today, Hour By Hour')).toBeNull();
    expect(weather).toHaveBeenCalledTimes(2);
  });

  it('offers a city when location is turned off, and keeps the pick', async () => {
    geolocation({ error: 1 });
    const updateConfig = vi.fn();
    render(<WeatherWidget config={{ mode: 'here' }} updateConfig={updateConfig} />);
    expect(await screen.findByText(/Location is turned off/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search for a city'), { target: { value: 'Pune' } });
    fireEvent.click(await screen.findByText('Pune', {}, { timeout: 2000 }));
    expect(updateConfig).toHaveBeenCalledWith({ mode: 'place', place: expect.objectContaining({ name: 'Pune', lat: 18.52 }) });
  });

  it('offers a city when the location prompt is never answered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(global.navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: () => {} } });
    try {
      render(<WeatherWidget config={{ mode: 'here' }} />);
      expect(screen.queryByLabelText('Search for a city')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(10500); });
      expect(screen.getByText(/has not shared your location yet/)).toBeTruthy();
      expect(screen.getByLabelText('Search for a city')).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('uses a picked city and its units', async () => {
    render(<WeatherWidget config={{ mode: 'place', units: 'metric', place: { name: 'Pune', country: 'India', countryCode: 'IN', lat: 18.52, lon: 73.86 } }} />);
    await waitFor(() => expect(weather).toHaveBeenCalledWith(18.52, 73.86, 'metric'));
    expect(await screen.findByText('Pune, India')).toBeTruthy();
    expect(weatherPlaceName).not.toHaveBeenCalled();   // a picked city already has its name
  });

  it('follows a construction project - the jobsite is the place (Neil, 10/30/2026)', async () => {
    render(<WeatherWidget config={{ mode: 'project', project: { id: 'p1', name: 'GS Temecula', lat: 33.49, lon: -117.15 } }} />);
    await waitFor(() => expect(weather).toHaveBeenCalledWith(33.49, -117.15, 'imperial'));
    expect(await screen.findByText('GS Temecula')).toBeTruthy();
    expect(weatherPlaceName).not.toHaveBeenCalled();
    // Configure: only active projects with a map point are offered.
    const onChange = vi.fn();
    render(<WeatherConfigFields config={{ mode: 'project' }} onChange={onChange} />);
    expect(await screen.findByRole('option', { name: /GS Temecula/ })).toBeTruthy();
    expect(screen.queryByText('No Point Yet')).toBeNull();
    expect(screen.queryByText('Done')).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /GS Temecula/ }));
    expect(onChange).toHaveBeenCalledWith({ project: expect.objectContaining({ id: 'p1', lat: 33.49, lon: -117.15 }) });
  });

  it('config needs a city only in city mode, a project in project mode, and reads the sky right', () => {
    expect(weatherConfigValid({ mode: 'here' })).toBe(true);
    expect(weatherConfigValid({ mode: 'place' })).toBe(false);
    expect(weatherConfigValid({ mode: 'place', place: { lat: 1, lon: 1 } })).toBe(true);
    expect(weatherConfigValid({ mode: 'project' })).toBe(false);
    expect(weatherConfigValid({ mode: 'project', project: { lat: 1, lon: 1 } })).toBe(true);
    expect(sky(0, false).text).toBe('Clear');
    expect(sky(95).text).toBe('Thunderstorms');
    const onChange = vi.fn();
    render(<WeatherConfigFields config={{ mode: 'here' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '°C · km/h' }));
    expect(onChange).toHaveBeenCalledWith({ units: 'metric' });
  });
});
