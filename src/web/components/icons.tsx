// Font Awesome icon set (tree-shaken SVG imports; no CDN, PWA-safe).
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faPlay,
  faMagnifyingGlass,
  faTableCellsLarge,
  faListUl,
  faGear,
  faCheck,
  faPlus,
  faChevronRight,
  faTrashCan,
  faBookmark,
  faHeart,
  faEye,
  faEyeSlash,
  faArrowUp,
  faArrowDown,
  faChevronLeft,
  faCalendarDays,
  faClock,
  faFilm,
  faTv,
  faStar,
  faUser,
  faUserGroup,
  faTriangleExclamation,
  faDownload,
  faArrowUpRightFromSquare,
  faComment,
  faXmark,
  faBell,
  faShareNodes,
  faLock,
  faPencil,
  faHandshake,
} from "@fortawesome/free-solid-svg-icons";
import { faHeart as faHeartOutline } from "@fortawesome/free-regular-svg-icons";

const wrap = (icon: IconDefinition) => (props: { size?: number }) => (
  <FontAwesomeIcon icon={icon} style={{ fontSize: props.size ?? 17 }} aria-hidden="true" />
);

export const IconPlay = wrap(faPlay);
export const IconSearch = wrap(faMagnifyingGlass);
export const IconLibrary = wrap(faTableCellsLarge);
export const IconList = wrap(faListUl);
export const IconGear = wrap(faGear);
export const IconCheck = wrap(faCheck);
export const IconPlus = wrap(faPlus);
export const IconChevron = wrap(faChevronRight);
export const IconChevronLeft = wrap(faChevronLeft);
export const IconTrash = wrap(faTrashCan);
export const IconBookmark = wrap(faBookmark);
export const IconHeart = wrap(faHeart);
export const IconHeartOutline = wrap(faHeartOutline);
export const IconEye = wrap(faEye);
export const IconEyeSlash = wrap(faEyeSlash);
export const IconArrowUp = wrap(faArrowUp);
export const IconArrowDown = wrap(faArrowDown);
export const IconCalendar = wrap(faCalendarDays);
export const IconClock = wrap(faClock);
export const IconFilm = wrap(faFilm);
export const IconTv = wrap(faTv);
export const IconStar = wrap(faStar);
export const IconUser = wrap(faUser);
export const IconUsers = wrap(faUserGroup);
export const IconWarning = wrap(faTriangleExclamation);
export const IconDownload = wrap(faDownload);
export const IconExternal = wrap(faArrowUpRightFromSquare);
export const IconComment = wrap(faComment);
export const IconClose = wrap(faXmark);
export const IconBell = wrap(faBell);
export const IconShare = wrap(faShareNodes);
export const IconLock = wrap(faLock);
export const IconPencil = wrap(faPencil);
export const IconHandshake = wrap(faHandshake);

// Brand glyphs — not in the Font Awesome free-solid/regular sets, so inlined
// to avoid pulling in the free-brands package for two icons. `currentColor`
// lets links style them like text.
export const IconX = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);
export const IconDiscord = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.955 2.419-2.157 2.419zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.946 2.419-2.157 2.419z" />
  </svg>
);
