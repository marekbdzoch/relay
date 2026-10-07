import { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Badge, Modal, Popover, initials } from './ui.tsx';
import { resetStore } from '../test/helpers.ts';

beforeEach(() => resetStore());

describe('Modal', () => {
  it('renders a dialog with title, body and footer', () => {
    render(
      <Modal title="Create a channel" subtitle="in Acme" onClose={() => {}} footer={<button>Create</button>}>
        <p>Body text</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'Create a channel' })).toBeInTheDocument();
    expect(screen.getByText('in Acme')).toBeInTheDocument();
    expect(screen.getByText('Body text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Modal title="T" onClose={onClose}>x</Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via the close button', () => {
    const onClose = vi.fn();
    render(<Modal title="T" onClose={onClose}>x</Modal>);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on a backdrop click but not on clicks inside the dialog', () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose}>inside</Modal>);
    fireEvent.mouseDown(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalled();
  });

  it('has no header without a title', () => {
    render(<Modal onClose={() => {}}>x</Modal>);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('lets an open popover handle Escape first', () => {
    const onModalClose = vi.fn();
    const onPopoverClose = vi.fn();
    render(
      <Modal title="T" onClose={onModalClose}>
        <Popover anchor={{ x: 10, y: 10 }} onClose={onPopoverClose}>
          menu
        </Popover>
      </Modal>,
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onPopoverClose).toHaveBeenCalledTimes(1);
    expect(onModalClose).not.toHaveBeenCalled();
  });
});

function PopoverHarness({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <div>
      <button ref={ref} onClick={() => setAnchor(ref.current)}>
        Open
      </button>
      <span>Outside</span>
      {anchor && (
        <Popover anchor={anchor} onClose={onClose} placement="bottom-end">
          <button>Inside item</button>
        </Popover>
      )}
    </div>
  );
}

describe('Popover', () => {
  it('renders its content into the document body', () => {
    render(<PopoverHarness onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const item = screen.getByRole('button', { name: 'Inside item' });
    expect(item.closest('body')).toBe(document.body);
  });

  it('closes on an outside click but not on clicks inside or on the anchor', () => {
    const onClose = vi.fn();
    render(<PopoverHarness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Inside item' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Open' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByText('Outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<PopoverHarness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when clicking inside a nested popover', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Popover anchor={{ x: 0, y: 0 }} onClose={outer}>
        outer
        <Popover anchor={{ x: 50, y: 50 }} onClose={inner} placement="right-start">
          <span>nested item</span>
        </Popover>
      </Popover>,
    );
    fireEvent.mouseDown(screen.getByText('nested item'));
    expect(outer).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('positions for every placement without throwing', () => {
    for (const placement of ['bottom-start', 'bottom-end', 'top-start', 'top-end', 'right-start', 'left-start', 'right-end'] as const) {
      const { unmount } = render(
        <Popover anchor={new DOMRect(100, 100, 20, 20)} onClose={() => {}} placement={placement}>
          {placement}
        </Popover>,
      );
      expect(screen.getByText(placement)).toBeInTheDocument();
      unmount();
    }
  });
});

describe('small helpers', () => {
  it('initials', () => {
    expect(initials('Jana Nováková')).toBe('JN');
    expect(initials('jana')).toBe('J');
    expect(initials('  anna  maria  svobodová ')).toBe('AS');
    expect(initials('')).toBe('?');
  });

  it('Badge caps at 99+ and hides zero', () => {
    const { container, rerender } = render(<Badge count={0} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<Badge count={7} />);
    expect(container).toHaveTextContent('7');
    rerender(<Badge count={150} />);
    expect(container).toHaveTextContent('99+');
  });
});
