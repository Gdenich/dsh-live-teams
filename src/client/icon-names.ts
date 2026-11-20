/**
 * The icon names this plugin looks for, newest naming scheme first.
 *
 * Kept apart from the resolver so it can be checked without loading the host's primitives package:
 * the resolver imports the real module, a test cannot.
 */
export const ICON_CANDIDATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  IconEdit: ['IconEditOutlineRegular', 'IconEditOutlineMedium', 'IconEditOutline16'],
  IconPlus: ['IconPlusOutlineRegular', 'IconPlusOutlineMedium', 'IconPlusOutline16'],
  IconPause: ['IconPauseOutlineRegular', 'IconPauseOutlineMedium', 'IconPauseOutline16'],
  IconPlay: ['IconPlayOutlineRegular', 'IconPlayOutlineMedium', 'IconPlayOutline16'],
  IconRefresh: ['IconRefreshOutlineRegular', 'IconRefreshOutlineMedium', 'IconRefreshOutline16'],
  IconChevronDown: ['IconChevronDownOutlineRegular', 'IconChevronDownOutlineMedium', 'IconChevronDownOutline14'],
})
