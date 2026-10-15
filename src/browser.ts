// What a browser bundle gets instead of the client. A Sume key spends money,
// and anything in a page can be read by whoever opens it.
throw new Error(
  "@sume-com/open runs on servers only: a key in a browser can be read by anyone who opens the page.\n" +
    "Fix: call it from your backend (an API route, a server action, a worker) and send the result to the browser.",
);
