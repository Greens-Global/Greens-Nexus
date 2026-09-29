import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Weather widget (Sep 29): my location or a picked city, a forecast that
// renders, and a graceful path when the browser refuses location.

const weather = vi.fn();
const weatherPlaces = vi.fn();
const weatherPlaceName = vi.fn();
vi.mock('../api', () => ({
  api: {
    weather: (...a) => weather(...a),
    weatherPlaces: (...a) => weatherPlaces(...a),
    weatherPlaceName: (...a) => weatherPlaceName(...a),
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
    expect(screen.getByLabelText('Next 12 hours').textContent).toContain('Now');
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

  it('uses a picked city and its units', async () => {
    render(<WeatherWidget config={{ mode: 'place', units: 'metric', place: { name: 'Pune', country: 'India', countryCode: 'IN', lat: 18.52, lon: 73.86 } }} />);
    await waitFor(() => expect(weather).toHaveBeenCalledWith(18.52, 73.86, 'metric'));
    expect(await screen.findByText('Pune, India')).toBeTruthy();
    expect(weatherPlaceName).not.toHaveBeenCalled();   // a picked city already has its name
  });

  it('config needs a city only in city mode, and reads the sky right', () => {
    expect(weatherConfigValid({ mode: 'here' })).toBe(true);
    expect(weatherConfigValid({ mode: 'place' })).toBe(false);
    expect(weatherConfigValid({ mode: 'place', place: { lat: 1, lon: 1 } })).toBe(true);
    expect(sky(0, false).text).toBe('Clear');
    expect(sky(95).text).toBe('Thunderstorms');
    const onChange = vi.fn();
    render(<WeatherConfigFields config={{ mode: 'here' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '°C · km/h' }));
    expect(onChange).toHaveBeenCalledWith({ units: 'metric' });
  });
});
