import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** How far from the end still counts as being at it: a rounding error, half a line. */
const AT_END_SLACK_PX = 32;

/** Shows the end of `element`, and says where that left its top. */
function scrollToEnd(element: HTMLElement): number {
  element.scrollTo({ top: element.scrollHeight });
  return element.scrollTop;
}

/**
 * Keeps a scrolling conversation on its newest line while the reader is there,
 * and lets go the moment they scroll up to read something older.
 *
 * It used to scroll to the end on every new word, which pulled the reader back
 * down mid-sentence whenever they scrolled up during an answer (reported
 * 2026-10-16). Now the intent decides: a wheel turned upwards, or the
 * scrollbar dragged up, releases the view; coming back to the end - by hand or
 * with `toEnd` - takes it again. Growth is watched with a ResizeObserver on
 * the content rather than on any list of what changed, so a chip that unfolds
 * or a table that finishes laying out is followed as well as a new word.
 *
 * @param scroller the element that scrolls.
 * @param content the element inside it that grows.
 */
export function useStickToBottom(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
): { following: boolean; toEnd: () => void } {
  const [following, setFollowing] = useState(true);
  /** The same flag for the observers, which must not wait for a render to read it. */
  const followingRef = useRef(true);
  const lastTop = useRef(0);

  const follow = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  }, []);

  const toEnd = () => {
    const element = scroller.current;
    if (element === null) return;
    lastTop.current = scrollToEnd(element);
    follow(true);
  };

  useEffect(() => {
    const element = scroller.current;
    const grown = content.current;
    if (element === null || grown === null) return;

    const onScroll = () => {
      const fromEnd = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (fromEnd <= AT_END_SLACK_PX) follow(true);
      // Only the reader moves the view up: following only ever moves it down.
      else if (element.scrollTop < lastTop.current) follow(false);
      lastTop.current = element.scrollTop;
    };
    // The wheel says so before the first scroll event does - and a smooth
    // scroll that has only just begun would otherwise be yanked back down.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) follow(false);
    };
    const keepUp = () => {
      if (followingRef.current) lastTop.current = scrollToEnd(element);
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    // The content growing, and the box shrinking under a taller composer.
    const observer = new ResizeObserver(keepUp);
    observer.observe(grown);
    observer.observe(element);
    keepUp();
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      observer.disconnect();
    };
  }, [scroller, content, follow]);

  return { following, toEnd };
}
