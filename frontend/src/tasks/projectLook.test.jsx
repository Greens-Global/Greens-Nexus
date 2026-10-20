import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FolderKanban, HardHat } from 'lucide-react';
import { projectLook, PROJECT_ICONS, PROJECT_COLORS, DEFAULT_PROJECT_COLOR } from './projectLook';
import ProjectIcon from './ProjectIcon';
import ProjectLookPicker from './ProjectLookPicker';

// A project's color and icon (Neil, Oct 15 2026). The promise: a project
// nobody has styled looks exactly as it did before, on every screen; a bad
// or unknown value falls back rather than drawing nothing.

describe('projectLook', () => {
  it('an unstyled project is the folder in the default blue', () => {
    const look = projectLook({ name: 'Ops', color: null, icon: null });
    expect(look.Icon).toBe(FolderKanban);
    expect(look.color).toBe(DEFAULT_PROJECT_COLOR);
    expect(look.iconKey).toBe('folder');
  });

  it("keeps each screen's own neutral for an unstyled project", () => {
    expect(projectLook({ color: '' }, '#7c3aed').color).toBe('#7c3aed');
    expect(projectLook(null, 'var(--nx-faint)').color).toBe('var(--nx-faint)');
    // ...but a color someone picked wins everywhere.
    expect(projectLook({ color: '#DB2777' }, '#7c3aed').color).toBe('#db2777');
  });

  it('draws a chosen icon, and the folder for one it does not know', () => {
    expect(projectLook({ icon: 'hard-hat' }).Icon).toBe(HardHat);
    expect(projectLook({ icon: 'retired-icon' }).Icon).toBe(FolderKanban);
    expect(projectLook({ color: 'red' }).color).toBe(DEFAULT_PROJECT_COLOR);
  });

  it('has unique keys and twelve colors', () => {
    expect(Object.keys(PROJECT_ICONS).length).toBeGreaterThanOrEqual(40);
    expect(new Set(PROJECT_COLORS.map((c) => c.hex)).size).toBe(12);
  });
});

describe('ProjectIcon', () => {
  it('is decorative and carries the color', () => {
    const { container } = render(<ProjectIcon project={{ icon: 'truck', color: '#16a34a' }} />);
    const svg = container.querySelector('svg');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('class')).toContain('truck');
    expect(svg.style.color).toBe('rgb(22, 163, 74)');
  });
});

describe('ProjectLookPicker', () => {
  const open = (props) => {
    const onChange = vi.fn();
    render(<ProjectLookPicker color="" icon="" onChange={onChange} {...props} />);
    fireEvent.click(screen.getByTitle('Change Icon and Color'));
    return onChange;
  };

  it('names what is picked on its button', () => {
    render(<ProjectLookPicker color="#0d9488" icon="hard-hat" onChange={() => {}} />);
    expect(screen.getByTitle('Change Icon and Color').getAttribute('aria-label'))
      .toBe('Project icon and color: Hard Hat, Teal. Change');
  });

  it('a color keeps the icon, an icon keeps the color', () => {
    const onChange = open({ color: '#0d9488', icon: 'hard-hat' });
    fireEvent.click(screen.getByRole('button', { name: 'Pink' }));
    expect(onChange).toHaveBeenLastCalledWith({ color: '#db2777', icon: 'hard-hat' });
    fireEvent.click(screen.getByRole('button', { name: 'Delivery' }));
    expect(onChange).toHaveBeenLastCalledWith({ color: '#0d9488', icon: 'truck' });
    expect(screen.getByRole('button', { name: 'Teal' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Hard Hat' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('searches icons by name or group, and says when nothing matches', () => {
    open();
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'finance' } });
    expect(screen.getByRole('button', { name: 'Calculator' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hard Hat' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'zzz' } });
    expect(screen.getByText('No icons match "zzz".')).toBeTruthy();
  });

  it('Reset to Default is off when the project is already default', () => {
    open();
    expect(screen.getByText('Reset to Default').disabled).toBe(true);
  });

  it('Reset to Default clears both', () => {
    const onChange = open({ color: '#dc2626', icon: 'bug' });
    fireEvent.click(screen.getByText('Reset to Default'));
    expect(onChange).toHaveBeenLastCalledWith({ color: '', icon: '' });
  });
});
