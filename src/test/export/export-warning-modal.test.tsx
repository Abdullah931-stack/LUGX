/**
 * Phase 10 Test Suite: ExportWarningModal UI Component Tests
 *
 * Verifies:
 * 1. Renders when isOpen is true with amber security warning.
 * 2. Displays file name and format extension.
 * 3. Calls onConfirm when clicking confirm button.
 * 4. Calls onClose when clicking cancel button or X icon.
 * 5. Handles Escape key to close modal.
 * 6. Does not render when isOpen is false.
 */

// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportWarningModal } from '@/components/export/export-warning-modal';

describe('ExportWarningModal Component', () => {
    const mockOnClose = vi.fn();
    const mockOnConfirm = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not render when isOpen is false', () => {
        const { container } = render(
            <ExportWarningModal
                isOpen={false}
                onClose={mockOnClose}
                onConfirm={mockOnConfirm}
                fileName="classified-notes"
                format="md"
            />
        );

        expect(container.firstChild).toBeNull();
        expect(screen.queryByTestId('export-warning-modal')).toBeNull();
    });

    it('renders dialog elements and file details when isOpen is true', () => {
        render(
            <ExportWarningModal
                isOpen={true}
                onClose={mockOnClose}
                onConfirm={mockOnConfirm}
                fileName="classified-notes"
                format="md"
            />
        );

        expect(screen.getByTestId('export-warning-modal')).toBeDefined();
        expect(screen.getByText(/تحذير أمني: تصدير مستند مشفر/i)).toBeDefined();
        expect(screen.getByText('classified-notes.md')).toBeDefined();
        expect(screen.getByTestId('confirm-export-button')).toBeDefined();
        expect(screen.getByTestId('cancel-export-button')).toBeDefined();
    });

    it('calls onConfirm when user clicks the confirmation button', () => {
        render(
            <ExportWarningModal
                isOpen={true}
                onClose={mockOnClose}
                onConfirm={mockOnConfirm}
                fileName="financial-data"
                format="txt"
            />
        );

        const confirmBtn = screen.getByTestId('confirm-export-button');
        fireEvent.click(confirmBtn);

        expect(mockOnConfirm).toHaveBeenCalledTimes(1);
        expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('calls onClose when user clicks the cancel button', () => {
        render(
            <ExportWarningModal
                isOpen={true}
                onClose={mockOnClose}
                onConfirm={mockOnConfirm}
                fileName="financial-data"
                format="txt"
            />
        );

        const cancelBtn = screen.getByTestId('cancel-export-button');
        fireEvent.click(cancelBtn);

        expect(mockOnClose).toHaveBeenCalledTimes(1);
        expect(mockOnConfirm).not.toHaveBeenCalled();
    });

    it('calls onClose when user clicks the X close button', () => {
        render(
            <ExportWarningModal
                isOpen={true}
                onClose={mockOnClose}
                onConfirm={mockOnConfirm}
                fileName="financial-data"
                format="txt"
            />
        );

        const closeBtn = screen.getByRole('button', { name: /إغلاق/i });
        fireEvent.click(closeBtn);

        expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape key press when not exporting', () => {
        render(
            <ExportWarningModal
                isOpen={true}
                onClose={mockOnClose}
                onConfirm={mockOnConfirm}
                fileName="financial-data"
                format="txt"
                isExporting={false}
            />
        );

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('disables buttons and does not close on Escape when isExporting is true', () => {
        render(
            <ExportWarningModal
                isOpen={true}
                onClose={mockOnClose}
                onConfirm={mockOnConfirm}
                fileName="financial-data"
                format="txt"
                isExporting={true}
            />
        );

        const confirmBtn = screen.getByTestId('confirm-export-button') as HTMLButtonElement;
        const cancelBtn = screen.getByTestId('cancel-export-button') as HTMLButtonElement;

        expect(confirmBtn.disabled).toBe(true);
        expect(cancelBtn.disabled).toBe(true);

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(mockOnClose).not.toHaveBeenCalled();
    });
});
