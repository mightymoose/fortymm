// The journal's append lock (design 5.4, the Web row): a Web Lock held for each append to the
// journal and while the device key is made (J1, J6). Every tab, worker and the service worker uses
// this one name, so it is one lock for the whole device.
export const appendLock = 'fortymm-journal-append'
