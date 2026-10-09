import {useCallback, useLayoutEffect, useRef, useState} from 'react';

// Keep user intent separate from scrollTop: the browser also changes scrollTop
// when the composer/keyboard resizes or a streamed message is replaced.
export function useConversationScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const measured = useRef({top: 0, height: 0, width: 0, content: 0});
  const anchor = useRef<{element: Element; offset: number} | null>(null);
  const setFollowing = useCallback((value: boolean) => {
    if (following.current === value) return;
    following.current = value;
    setIsAtBottom(value);
  }, []);
  const measure = useCallback((captureAnchor = true) => {
    const node = scrollRef.current;
    if (!node) return;
    measured.current = {top: node.scrollTop, height: node.clientHeight, width: node.clientWidth, content: node.scrollHeight};
    if (following.current) {anchor.current = null; return;}
    // Streaming growth below a reader's anchor needs no history lookup.
    if (!captureAnchor && anchor.current?.element.isConnected) return;
    const content = contentRef.current;
    if (!content || !node.clientHeight) return;
    const top = node.getBoundingClientRect().top, children = content.children;
    // Timeline entries are ordered direct siblings. Binary search avoids an
    // all-history query/scan on every touch/scroll while keeping a real DOM
    // anchor for automatic archive prepends and images that finish loading.
    let low = 0, high = children.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (children[middle].getBoundingClientRect().bottom < top) low = middle + 1;
      else high = middle;
    }
    // Loading captions are transient; anchor the first actual history row.
    while (low < children.length && !children[low].hasAttribute('data-timeline-key')) low++;
    const element = children[low];
    anchor.current = element ? {element, offset: element.getBoundingClientRect().top - top} : null;
  }, []);
  const scrollToBottom = useCallback(() => {
    setFollowing(true);
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    measure();
  }, [measure, setFollowing]);

  useLayoutEffect(() => {
    const node = scrollRef.current, content = contentRef.current;
    if (!node || !content) return;
    const nearBottom = () => node.scrollHeight - node.clientHeight - node.scrollTop <= 4;
    const resized = () => {
      if (!node.clientHeight) return;
      if (following.current) node.scrollTop = node.scrollHeight;
      else {
        const previous = anchor.current;
        if (previous?.element.isConnected && node.contains(previous.element)) {
          const offset = previous.element.getBoundingClientRect().top - node.getBoundingClientRect().top;
          if (Math.abs(offset - previous.offset) > 1) node.scrollTop += offset - previous.offset;
        }
        if (nearBottom()) setFollowing(true);
      }
      measure(false);
    };
    const onScroll = () => {
      if (!node.clientHeight) return;
      const previous = measured.current;
      // A resize can emit scroll before ResizeObserver runs. Handle both in
      // the same place so clamping scrollTop never looks like scrolling up.
      if (previous.height !== node.clientHeight || previous.width !== node.clientWidth || previous.content !== node.scrollHeight) {
        resized();
      } else {
        const moved = Math.abs(previous.top - node.scrollTop) > 1;
        if (moved) setFollowing(nearBottom());
        measure(moved);
      }
    };
    const scrollsConversation = (target: EventTarget | null, delta: number) => {
      for (let element = target instanceof Element ? target : null; element && element !== node; element = element.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight &&
          (delta < 0 ? element.scrollTop > 0 : element.scrollTop < element.scrollHeight - element.clientHeight)) return false;
      }
      return node.scrollHeight > node.clientHeight;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && scrollsConversation(event.target, event.deltaY)) setFollowing(false);
    };
    let touchY: number | undefined;
    const onTouchStart = (event: TouchEvent) => {touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined;};
    const onTouchMove = (event: TouchEvent) => {
      if (touchY === undefined || event.touches.length !== 1) return;
      const next = event.touches[0].clientY, delta = touchY - next;
      if (delta < -2 && scrollsConversation(event.target, delta)) setFollowing(false);
      touchY = next;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && scrollsConversation(event.target, -1)) setFollowing(false);
    };
    node.addEventListener('scroll', onScroll, {passive: true});
    node.addEventListener('wheel', onWheel, {passive: true});
    node.addEventListener('touchstart', onTouchStart, {passive: true});
    node.addEventListener('touchmove', onTouchMove, {passive: true});
    node.addEventListener('keydown', onKeyDown);
    const observer = new ResizeObserver(resized);
    observer.observe(node);
    observer.observe(content);
    resized();
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('keydown', onKeyDown);
    };
  }, [measure, setFollowing]);
  return {scrollRef, contentRef, scrollToBottom, isAtBottom};
}
