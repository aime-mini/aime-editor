import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { firstShown } from "../lib/chatWindow";

/**
 * The part of a conversation that is drawn: its newest page, and one page
 * more for each time the reader asks for earlier messages. Messages added
 * above the reader keep what they were reading where it was. A session
 * opened anew starts again from its newest page.
 *
 * @param session the conversation shown; another one resets the window.
 * @param total how many messages it holds.
 * @param scroller the element the conversation scrolls in.
 */
export function useChatWindow(
  session: string,
  total: number,
  scroller: RefObject<HTMLElement | null>,
): { from: number; showEarlier: () => void } {
  const [shown, setShown] = useState({ session, pages: 1 });
  const pages = shown.session === session ? shown.pages : 1;
  /** How far the reader was from the end before earlier messages were added above. */
  const distanceFromEnd = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null || distanceFromEnd.current === null) return;
    element.scrollTo({ top: element.scrollHeight - distanceFromEnd.current });
    distanceFromEnd.current = null;
  }, [pages, scroller]);

  const showEarlier = () => {
    const element = scroller.current;
    if (element !== null) distanceFromEnd.current = element.scrollHeight - element.scrollTop;
    setShown({ session, pages: pages + 1 });
  };

  return { from: firstShown(total, pages), showEarlier };
}
