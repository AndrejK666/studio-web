// Which Studio the desktop connects to: the build's list (Dev, Test, Local),
// or an address the member types. One component, and one backend route
// (`/studio-desktop/environment`), for the landing page and the Studio view;
// each draws it in its own classes (`block`).

import * as React from '@theia/core/shared/react';
import type { DesktopEnvironmentChoice } from '../common/desktop-environments';
import { switchStudio } from './desktop-studio-client';

export interface StudioPickerProps {
    readonly choice: DesktopEnvironmentChoice;
    /** Called once the backend has switched, to read the new status. */
    readonly onSwitched: () => void;
    /** The `id` of the select, for its label. */
    readonly id?: string;
    /** The BEM block of the view it is drawn in: `studio-landing` or `studio-desktop`. */
    readonly block?: string;
}

export function StudioPicker({ choice, onSwitched, id = 'studio-landing-picker', block = 'studio-landing' }: StudioPickerProps): React.ReactElement | null {
    const current = choice.current;
    const [custom, setCustom] = React.useState(current?.id === 'custom');
    const [address, setAddress] = React.useState(current?.id === 'custom' ? current.studioUrl : '');
    const [error, setError] = React.useState('');
    if (!choice.switchable) {
        return null;
    }
    const go = async (target: { id: string } | { studioUrl: string }) => {
        setError('');
        const refused = await switchStudio(target).catch(e => String(e));
        if (refused) {
            setError(refused);
            return;
        }
        onSwitched();
    };
    const value = custom ? 'custom' : current?.id ?? '';
    return <div className={`${block}__picker`}>
        <label className={`${block}__label`} htmlFor={id}>Studio</label>
        <select id={id} className='theia-select' value={value}
            onChange={e => {
                if (e.target.value === 'custom') {
                    setCustom(true);
                } else {
                    setCustom(false);
                    void go({ id: e.target.value });
                }
            }}>
            {choice.environments.map(env => <option key={env.id} value={env.id}>{env.label} — {env.studioUrl.replace(/^https?:\/\//, '')}</option>)}
            <option value='custom'>{current?.id === 'custom' ? `Other — ${current.label}` : 'Other…'}</option>
        </select>
        {custom && <div className={`${block}__picker-custom`}>
            <input className='theia-input' placeholder='https://studio.example.com' aria-label='Studio address'
                value={address} onChange={e => setAddress(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void go({ studioUrl: address })} />
            <button className='theia-button secondary' onClick={() => void go({ studioUrl: address })}>Use</button>
        </div>}
        {error && <p className={`${block}__error`} role='alert'>{error}</p>}
    </div>;
}
