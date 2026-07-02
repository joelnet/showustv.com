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
  faStar,
  faUser,
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
export const IconStar = wrap(faStar);
export const IconUser = wrap(faUser);
