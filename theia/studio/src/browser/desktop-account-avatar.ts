// The desktop's account tab -- the Constructor Studio view on the left rail,
// whose icon is the person glyph -- shows the signed-in member's photo from
// their Studio profile instead.
//
// Not Theia's Accounts button: product-ext hides the whole sidebar menu it
// lives in (`.theia-sidebar-menu { display: none }`), and the person glyph a
// member sees is this view's tab. A stylesheet rather than a changed icon
// class, because the tab is re-rendered from the title on every layout
// change. Desktop only: a session in the portal sits under the portal's own
// header, photo and all.

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import { desktopStatus, onDesktopChange } from './desktop-studio-client';
import { StudioApi } from './studio-api';

/**
 * Where the photo is. The profile names an uploaded one by its path on the
 * Studio gateway (`<prefix>/studio-user/v1/avatars/<id>/<digest>`, served
 * without a token), and one taken from the identity provider by its address.
 */
export function avatarSource(avatarUrl: string | null | undefined, studioUrl: string | undefined): string | undefined {
    const url = avatarUrl?.trim();
    if (!url) {
        return undefined;
    }
    if (/^https:\/\//.test(url)) {
        return url;
    }
    return url.startsWith('/') && studioUrl ? `${studioUrl.replace(/\/+$/, '')}${url}` : undefined;
}

/** The Constructor Studio view's tab (`DESKTOP_STUDIO_WIDGET_ID`), as Theia renders it on the rail. */
export const ACCOUNT_TAB_ICON = '[id="shell-tab-studio.desktop"] .lm-TabBar-tabIcon';

/** The account tab, drawn as the photo in a circle the size of a rail icon. */
export function avatarCss(src: string): string {
    const quoted = JSON.stringify(src);
    return `${ACCOUNT_TAB_ICON} {
    background: center / cover no-repeat url(${quoted});
    border-radius: 50%;
    width: 24px;
    height: 24px;
}
${ACCOUNT_TAB_ICON}::before { content: ''; }`;
}

/** How often the sign-in is looked at again: a local call, and a sign-in can finish without any view announcing it. */
const WATCH_MS = 15_000;

/** Who the photo is of: a change of Studio, of person or of state is another photo, or none. */
export function photoKey(status: { state?: string; studioUrl?: string; user?: { sub?: string } } | undefined): string {
    return status?.state === 'signed-in' ? `${status.studioUrl ?? ''}|${status.user?.sub ?? ''}` : '';
}

@injectable()
export class DesktopAccountAvatar implements FrontendApplicationContribution {
    protected readonly style = document.createElement('style');
    /** The person the photo on show is of, once it was found; `undefined` asks again. */
    protected shown: string | undefined;

    onStart(): void {
        void desktopStatus().then(status => {
            if (!status?.enabled) {
                return;
            }
            document.head.appendChild(this.style);
            // The views announce a sign-in they started, but the window's own
            // sign-in at launch, or one finished in the browser, may pass
            // unannounced: the photo stayed the generic glyph. So the state is
            // also read on a timer, and the profile only when it changed.
            onDesktopChange(() => void this.refresh());
            setInterval(() => void this.refresh(), WATCH_MS);
            void this.refresh();
        });
    }

    protected async refresh(): Promise<void> {
        const status = await desktopStatus().catch(() => undefined);
        const key = photoKey(status);
        if (key === this.shown) {
            return;
        }
        const src = key && status ? await this.photo(status.studioUrl).catch(() => undefined) : undefined;
        this.style.textContent = src ? avatarCss(src) : '';
        // A photo that could not be read yet is asked for again next time.
        this.shown = src || !key ? key : undefined;
    }

    protected async photo(studioUrl: string | undefined): Promise<string | undefined> {
        const res = await StudioApi.fetch('/studio-user/v1/me');
        if (!res.ok) {
            return undefined;
        }
        const me = await res.json() as { avatar_url?: string | null };
        return avatarSource(me.avatar_url, studioUrl);
    }
}
