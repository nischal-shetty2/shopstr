import { Filter, nip04, nip44, SimplePool } from "nostr-tools";
import {
  addChatMessageToCache,
  addProductToCache,
  addProfilesToCache,
  fetchAllProductsFromCache,
  fetchChatMessagesFromCache,
  fetchProfileDataFromCache,
  removeProductFromCache,
} from "./cache-service";
import {
  NostrEvent,
  NostrMessageEvent,
  ShopSettings,
} from "@/utils/types/types";
import { CashuMint, CashuWallet, Proof } from "@cashu/cashu-ts";
import { ChatsMap } from "@/utils/context/context";
import { DateTime } from "luxon";
import {
  getLocalStorageData,
  getPrivKeyWithPassphrase,
} from "@/components/utility/nostr-helper-functions";
import {
  ProductData,
  parseTags,
} from "@/components/utility/product-parser-functions";
import { calculateWeightedScore } from "@/components/utility/review-parser-functions";
import { DeleteEvent } from "../../../pages/api/nostr/crud-service";

function getUniqueProofs(proofs: Proof[]): Proof[] {
  const uniqueProofs = new Set<string>();
  return proofs.filter((proof) => {
    const serializedProof = JSON.stringify(proof);
    if (!uniqueProofs.has(serializedProof)) {
      uniqueProofs.add(serializedProof);
      return true;
    }
    return false;
  });
}

function isHexString(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

export const fetchAllPosts = async (
  relays: string[],
  editProductContext: (productEvents: NostrEvent[], isLoading: boolean) => void,
  since?: number,
  until?: number,
): Promise<{
  productEvents: NostrEvent[];
  profileSetFromProducts: Set<string>;
}> => {
  return new Promise(async function (resolve, reject) {
    try {
      let deletedProductsInCacheSet: Set<any> = new Set(); // used to remove deleted items from cache
      try {
        let productArrayFromCache = await fetchAllProductsFromCache();
        deletedProductsInCacheSet = new Set(
          productArrayFromCache.map((product: NostrEvent) => product.id),
        );
        editProductContext(productArrayFromCache, false);
      } catch (error) {
        console.log("Failed to fetch all listings from cache: ", error);
      }

      const pool = new SimplePool();

      if (!since) {
        since = Math.trunc(DateTime.now().minus({ days: 14 }).toSeconds());
      }
      if (!until) {
        until = Math.trunc(DateTime.now().toSeconds());
      }

      const filter: Filter = {
        kinds: [30402],
        since,
        until,
      };

      let productArrayFromRelay: NostrEvent[] = [];
      let profileSetFromProducts: Set<string> = new Set();

      let h = pool.subscribeMany(relays, [filter], {
        onevent(event) {
          productArrayFromRelay.push(event);
          if (
            deletedProductsInCacheSet &&
            event.id in deletedProductsInCacheSet
          ) {
            deletedProductsInCacheSet.delete(event.id);
          }
          addProductToCache(event);
          profileSetFromProducts.add(event.pubkey);
        },
        oneose() {
          h.close();
          resolve({
            productEvents: productArrayFromRelay,
            profileSetFromProducts,
          });
          editProductContext(productArrayFromRelay, false);
          removeProductFromCache(Array.from(deletedProductsInCacheSet));
        },
      });
    } catch (error) {
      console.log("Failed to fetch all listings from relays: ", error);
      reject(error);
    }
  });
};

export const fetchCart = async (
  relays: string[],
  editCartContext: (cartAddresses: string[][], isLoading: boolean) => void,
  products: NostrEvent[],
  passphrase?: string,
  since?: number,
  until?: number,
): Promise<{
  cartList: ProductData[];
}> => {
  return new Promise(async function (resolve, reject) {
    try {
      const { signInMethod, userPubkey } = getLocalStorageData();

      const pool = new SimplePool();

      if (!since) {
        since = Math.trunc(DateTime.now().minus({ days: 14 }).toSeconds());
      }
      if (!until) {
        until = Math.trunc(DateTime.now().toSeconds());
      }

      const filter: Filter = {
        kinds: [10402],
        authors: [userPubkey],
        since,
        until,
      };

      let cartArrayFromRelay: ProductData[] = [];
      let cartAddressesArray: string[][] = [];

      let h = pool.subscribeMany(relays, [filter], {
        onevent: async (event) => {
          if (signInMethod === "extension") {
            let eventContent = await window.nostr.nip04.decrypt(
              userPubkey,
              event.content,
            );
            if (eventContent) {
              let addressArray = JSON.parse(eventContent);
              cartAddressesArray = addressArray;
              for (const addressElement of addressArray) {
                let address = addressElement[1];
                const [kind, pubkey, dTag] = address;
                if (kind === "30402") {
                  const foundEvent = products.find((event) =>
                    event.tags.some((tag) => tag[0] === "d" && tag[1] === dTag),
                  );
                  if (foundEvent) {
                    cartArrayFromRelay.push(
                      parseTags(foundEvent) as ProductData,
                    );
                  }
                }
              }
            }
          } else if (signInMethod === "nsec") {
            if (!passphrase) throw new Error("Passphrase is required");
            let senderPrivkey = getPrivKeyWithPassphrase(
              passphrase,
            ) as Uint8Array;
            let eventContent = await nip04.decrypt(
              senderPrivkey,
              userPubkey,
              event.content,
            );
            let addressArray = JSON.parse(eventContent);
            cartAddressesArray = addressArray;
            for (const addressElement of addressArray) {
              let address = addressElement[1];
              const [kind, pubkey, dTag] = address;
              if (kind === "30402") {
                const foundEvent = products.find((event) =>
                  event.tags.some((tag) => tag[0] === "d" && tag[1] === dTag),
                );
                if (foundEvent) {
                  cartArrayFromRelay.push(parseTags(foundEvent) as ProductData);
                }
              }
            }
          } else if (signInMethod === "amber") {
            const amberSignerUrl = `nostrsigner:${event.content}?pubKey=${userPubkey}&compressionType=none&returnType=signature&type=nip04_decrypt`;

            await navigator.clipboard.writeText("");

            window.open(amberSignerUrl, "_blank");

            const readClipboard = (): Promise<string[][]> => {
              return new Promise((resolve, reject) => {
                const checkClipboard = async () => {
                  try {
                    if (!document.hasFocus()) {
                      console.log("Document not focused, waiting for focus...");
                      return;
                    }

                    const clipboardContent =
                      await navigator.clipboard.readText();

                    if (clipboardContent && clipboardContent !== "") {
                      clearInterval(intervalId);
                      let eventContent = clipboardContent;

                      let parsedContent = JSON.parse(eventContent);

                      resolve(parsedContent);
                    } else {
                      console.log("Waiting for new clipboard content...");
                    }
                  } catch (error) {
                    console.error("Error reading clipboard:", error);
                    reject(error);
                  }
                };

                checkClipboard();
                const intervalId = setInterval(checkClipboard, 1000);

                setTimeout(() => {
                  clearInterval(intervalId);
                  console.log("Amber decryption timeout");
                  alert("Amber decryption timed out. Please try again.");
                }, 60000);
              });
            };

            try {
              let addressArray = await readClipboard();
              cartAddressesArray = addressArray;
              for (const addressElement of addressArray) {
                let address = addressElement[1];
                const [kind, pubkey, dTag] = address;
                if (kind === "30402") {
                  const foundEvent = products.find((event) =>
                    event.tags.some((tag) => tag[0] === "d" && tag[1] === dTag),
                  );
                  if (foundEvent) {
                    cartArrayFromRelay.push(
                      parseTags(foundEvent) as ProductData,
                    );
                  }
                }
              }
            } catch (error) {
              console.error("Error reading clipboard:", error);
              alert("Amber decryption failed. Please try again.");
            }
          }
        },
        oneose() {
          h.close();
          const uniqueProducts = new Map<
            string,
            ProductData & { selectedQuantity: number }
          >();

          cartArrayFromRelay.forEach((product) => {
            if (uniqueProducts.has(product.id)) {
              // If product exists, increment quantity
              const existing = uniqueProducts.get(product.id)!;
              existing.selectedQuantity += 1;
            } else {
              // If new product, add it with quantity 1
              uniqueProducts.set(product.id, {
                ...product,
                selectedQuantity: 1,
              });
            }
          });

          let updatedCartList = Array.from(uniqueProducts.values());

          resolve({
            cartList: updatedCartList,
          });
          editCartContext(cartAddressesArray, false);
        },
      });
    } catch (error) {
      console.log("Failed to fetch cart: ", error);
      reject(error);
    }
  });
};

export const fetchShopSettings = async (
  relays: string[],
  pubkeyShopSettingsToFetch: string[],
  editShopContext: (
    shopEvents: Map<string, ShopSettings>,
    isLoading: boolean,
  ) => void,
): Promise<{
  shopSettingsMap: Map<string, ShopSettings>;
}> => {
  return new Promise(async function (resolve, reject) {
    try {
      let shopEvents: NostrEvent[] = [];
      let shopSettings: Map<string, ShopSettings | any> = new Map(
        pubkeyShopSettingsToFetch.map((pubkey) => [pubkey, null]),
      );
      const pool = new SimplePool();
      let shopFilter: Filter = {
        kinds: [30019],
        authors: pubkeyShopSettingsToFetch,
      };
      let h = pool.subscribeMany(relays, [shopFilter], {
        onevent(event) {
          shopEvents.push(event);
        },
        oneose: async () => {
          h.close();
          if (shopEvents.length > 0) {
            shopEvents.sort((a, b) => b.created_at - a.created_at);
            const latestEventsMap: Map<string, NostrEvent> = new Map();
            shopEvents.forEach((event) => {
              if (!latestEventsMap.has(event.pubkey)) {
                latestEventsMap.set(event.pubkey, event);
              }
            });
            latestEventsMap.forEach((event, pubkey) => {
              try {
                const shopSetting = {
                  pubkey: event.pubkey,
                  content: JSON.parse(event.content),
                  created_at: event.created_at,
                };
                shopSettings.set(pubkey, shopSetting);
              } catch (error) {
                console.error(
                  `Failed to parse shop setting for pubkey: ${pubkey}`,
                  error,
                );
              }
            });
            editShopContext(shopSettings, false);
            resolve({ shopSettingsMap: shopSettings });
          } else {
            reject();
          }
        },
      });
    } catch (error) {
      reject(error);
    }
  });
};

export const fetchProfile = async (
  relays: string[],
  pubkeyProfilesToFetch: string[],
  editProfileContext: (
    productEvents: Map<any, any>,
    isLoading: boolean,
  ) => void,
): Promise<{
  profileMap: Map<string, any>;
}> => {
  return new Promise(async function (resolve, reject) {
    try {
      try {
        let profileData = await fetchProfileDataFromCache();
        editProfileContext(profileData, false);
      } catch (error) {
        console.log("Failed to fetch profiles: ", error);
      }

      const pool = new SimplePool();
      let subParams: { kinds: number[]; authors?: string[] } = {
        kinds: [0],
        authors: Array.from(pubkeyProfilesToFetch),
      };

      let profileMap: Map<string, any> = new Map(
        Array.from(pubkeyProfilesToFetch).map((pubkey) => [pubkey, null]),
      );

      let h = pool.subscribeMany(relays, [subParams], {
        onevent(event) {
          if (
            profileMap.get(event.pubkey) === null ||
            profileMap.get(event.pubkey).created_at > event.created_at
          ) {
            // update only if the profile is not already set or the new event is newer
            try {
              const content = JSON.parse(event.content);
              profileMap.set(event.pubkey, {
                pubkey: event.pubkey,
                created_at: event.created_at,
                content: content,
              });
            } catch (error) {
              console.error(
                `Failed parse profile for pubkey: ${event.pubkey}, ${event.content}`,
                error,
              );
            }
          }
        },
        oneose() {
          h.close();
          resolve({ profileMap });
          addProfilesToCache(profileMap);
        },
      });
    } catch (error) {
      reject(error);
    }
  });
};

export const fetchGiftWrappedChatsAndMessages = async (
  relays: string[],
  userPubkey: string,
  editChatContext: (chatsMap: ChatsMap, isLoading: boolean) => void,
  passphrase?: string,
  since?: number,
): Promise<{
  profileSetFromChats: Set<string>;
}> => {
  return new Promise(async function (resolve, reject) {
    // if no userPubkey, user is not signed in
    if (!userPubkey) {
      editChatContext(new Map(), false);
      resolve({ profileSetFromChats: new Set() });
    }
    const { signInMethod } = getLocalStorageData();
    let chatMessagesFromCache: Map<string, NostrMessageEvent> =
      await fetchChatMessagesFromCache();
    try {
      let chatsMap = new Map();
      let chatsReachedEOSE = false;

      const addToChatsMap = (
        pubkeyOfChat: string,
        event: NostrMessageEvent,
      ) => {
        // pubkeyOfChat is the person you are chatting with if incoming, or the person you are sending to if outgoing
        if (!chatsMap.has(pubkeyOfChat)) {
          chatsMap.set(pubkeyOfChat, [event]);
        } else {
          chatsMap.get(pubkeyOfChat).push(event);
        }
      };

      const onEOSE = () => {
        if (chatsReachedEOSE) {
          //sort chats by created_at
          chatsMap.forEach((value) => {
            value.sort(
              (a: NostrMessageEvent, b: NostrMessageEvent) =>
                a.created_at - b.created_at,
            );
          });
          resolve({ profileSetFromChats: new Set(chatsMap.keys()) });
          editChatContext(chatsMap, false);
        }
      };

      if (!since) {
        since = Math.trunc(DateTime.now().minus({ days: 14 }).toSeconds());
      }

      new SimplePool().subscribeMany(
        relays,
        [
          {
            kinds: [1059],
            "#p": [userPubkey],
            since,
          },
        ],
        {
          async onevent(event) {
            let messageEvent;

            if (signInMethod === "extension") {
              let sealEventString = await window.nostr.nip44.decrypt(
                event.pubkey,
                event.content,
              );
              let sealEvent = JSON.parse(sealEventString);
              if (sealEvent.kind === 13) {
                let messageEventString = await window.nostr.nip44.decrypt(
                  sealEvent.pubkey,
                  sealEvent.content,
                );
                let messageEventCheck = JSON.parse(messageEventString);
                if (messageEventCheck.pubkey === sealEvent.pubkey) {
                  messageEvent = messageEventCheck;
                }
              }
            } else if (signInMethod === "nsec") {
              if (!passphrase) throw new Error("Passphrase is required");
              let userPrivkey = getPrivKeyWithPassphrase(
                passphrase,
              ) as Uint8Array;
              const giftWrapConversationKey = nip44.getConversationKey(
                userPrivkey,
                event.pubkey,
              );
              let sealEventString = nip44.decrypt(
                event.content,
                giftWrapConversationKey,
              );
              let sealEvent = JSON.parse(sealEventString);
              if (sealEvent.kind === 13) {
                let sealConversationKey = nip44.getConversationKey(
                  userPrivkey,
                  sealEvent.pubkey,
                );
                let messageEventString = nip44.decrypt(
                  sealEvent.content,
                  sealConversationKey,
                );
                let messageEventCheck = JSON.parse(messageEventString);
                if (messageEventCheck.pubkey === sealEvent.pubkey) {
                  messageEvent = messageEventCheck;
                }
              }
            } else if (signInMethod === "amber") {
              const readClipboard = (): Promise<string> => {
                return new Promise((resolve, reject) => {
                  const checkClipboard = async () => {
                    try {
                      if (!document.hasFocus()) {
                        console.log(
                          "Document not focused, waiting for focus...",
                        );
                        return;
                      }

                      const clipboardContent =
                        await navigator.clipboard.readText();

                      if (clipboardContent && clipboardContent !== "") {
                        clearInterval(intervalId);
                        let eventContent = clipboardContent;

                        let parsedContent = JSON.parse(eventContent);

                        resolve(parsedContent);
                      } else {
                        console.log("Waiting for new clipboard content...");
                      }
                    } catch (error) {
                      console.error("Error reading clipboard:", error);
                      reject(error);
                    }
                  };

                  checkClipboard();
                  const intervalId = setInterval(checkClipboard, 1000);

                  setTimeout(() => {
                    clearInterval(intervalId);
                    console.log("Amber decryption timeout");
                    alert("Amber decryption timed out. Please try again.");
                  }, 60000);
                });
              };

              try {
                const giftWrapAmberSignerUrl = `nostrsigner:${event.content}?pubKey=${event.pubkey}&compressionType=none&returnType=signature&type=nip44_decrypt`;

                await navigator.clipboard.writeText("");

                window.open(giftWrapAmberSignerUrl, "_blank");

                let sealEventString = await readClipboard();
                let sealEvent = JSON.parse(sealEventString);
                if (sealEvent.kind == 13) {
                  const sealAmberSignerUrl = `nostrsigner:${sealEvent.content}?pubKey=${event.pubkey}&compressionType=none&returnType=signature&type=nip44_decrypt`;

                  await navigator.clipboard.writeText("");

                  window.open(sealAmberSignerUrl, "_blank");

                  let messageEventString = await readClipboard();
                  let messageEventCheck = JSON.parse(messageEventString);
                  if (messageEventCheck.pubkey === sealEvent.pubkey) {
                    messageEvent = messageEventCheck;
                  }
                }
              } catch (error) {
                console.error("Error reading clipboard:", error);
                alert("Amber decryption failed. Please try again.");
              }
            }
            let senderPubkey = messageEvent.pubkey;
            let tagsMap: Map<string, string> = new Map(
              messageEvent.tags.map(([k, v]: [string, string]) => [k, v]),
            );
            let subject = tagsMap.get("subject")
              ? tagsMap.get("subject")
              : null;
            if (
              subject !== "listing-inquiry" &&
              subject !== "order-payment" &&
              subject !== "order-info" &&
              subject !== "payment-change" &&
              subject !== "order-receipt" &&
              subject !== "shipping-info"
            ) {
              return;
            }
            let recipientPubkey = tagsMap.get("p") ? tagsMap.get("p") : null; // pubkey you sent the message to
            if (typeof recipientPubkey !== "string") {
              console.error(
                `fetchAllOutgoingChats: Failed to get recipientPubkey from tagsMap",
                    ${tagsMap},
                    ${event}`,
              );
              alert(
                `fetchAllOutgoingChats: Failed to get recipientPubkey from tagsMap`,
              );
              return;
            }
            let chatMessage = chatMessagesFromCache.get(messageEvent.id);
            if (!chatMessage) {
              chatMessage = { ...messageEvent, sig: "", read: false }; // false because the user received it and it wasn't in the cache
              if (chatMessage) {
                addChatMessageToCache(chatMessage);
              }
            }
            if (senderPubkey === userPubkey && chatMessage) {
              addToChatsMap(recipientPubkey, chatMessage);
            } else if (chatMessage) {
              addToChatsMap(senderPubkey, chatMessage);
            }
            if (chatsReachedEOSE) {
              editChatContext(chatsMap, false);
            }
          },
          async oneose() {
            chatsReachedEOSE = true;
            onEOSE();
          },
          onclose(reasons) {
            console.log(reasons);
          },
        },
      );
    } catch (error) {
      console.log("Failed to fetch chats and messages: ", error);
      reject(error);
    }
  });
};

export const fetchReviews = async (
  relays: string[],
  products: NostrEvent[],
  editReviewsContext: (
    merchantReviewsMap: Map<string, number[]>,
    productReviewsMap: Map<string, Map<string, Map<string, string[][]>>>,
    isLoading: boolean,
  ) => void,
): Promise<{
  merchantScoresMap: Map<string, number[]>;
  productReviewsMap: Map<string, Map<string, Map<string, string[][]>>>;
}> => {
  return new Promise(async function (resolve, reject) {
    try {
      const pool = new SimplePool();

      const addresses = products
        .map((product) => {
          const dTag = product.tags.find(
            (tag: string[]) => tag[0] === "d",
          )?.[1];
          if (!dTag) return null;
          return `a:${product.kind}:${product.pubkey}:${dTag}`;
        })
        .filter((address): address is string => address !== null);

      const reviewsFilter: Filter = {
        kinds: [31555],
        "#d": addresses,
      };

      const merchantScoresMap = new Map<string, number[]>();
      const productReviewsMap = new Map<
        string,
        Map<string, Map<string, string[][]>>
      >();

      let h = pool.subscribeMany(relays, [reviewsFilter], {
        onevent(event) {
          const addressTag = event.tags.find((tag) => tag[0] === "d")?.[1];
          if (!addressTag) return;

          const [_, kind, merchantPubkey, productDTag] = addressTag.split(":");
          if (!merchantPubkey || !productDTag) return;

          const ratingTags = event.tags.filter((tag) => tag[0] === "rating");
          const commentArray = ["comment", event.content];
          ratingTags.unshift(commentArray);

          // Add score to merchant's scores (all reviews)
          if (!merchantScoresMap.has(merchantPubkey)) {
            merchantScoresMap.set(merchantPubkey, []);
          }
          merchantScoresMap
            .get(merchantPubkey)!
            .push(calculateWeightedScore(event.tags));

          // Initialize merchant map if doesn't exist
          if (!productReviewsMap.has(merchantPubkey)) {
            productReviewsMap.set(merchantPubkey, new Map());
          }

          // Initialize product map if doesn't exist
          const merchantProducts = productReviewsMap.get(merchantPubkey)!;
          if (!merchantProducts.has(productDTag)) {
            merchantProducts.set(productDTag, new Map());
          }

          // Add or update review
          const productReviews = merchantProducts.get(productDTag)!;

          const createdAt = event.created_at;

          // Only update if this is a newer review from this pubkey
          const existingReview = productReviews.get(event.pubkey);
          if (
            !existingReview ||
            createdAt >
              Number(
                existingReview.find((item) => item[0] === "created_at")?.[1],
              )
          ) {
            // Replace the existing created_at or set a new entry
            const updatedReview = existingReview
              ? existingReview.map((item) => {
                  if (item[0] === "created_at") {
                    return ["created_at", createdAt.toString()]; // Replace the created_at entry
                  }
                  return item; // Keep existing items
                })
              : [...ratingTags, ["created_at", createdAt.toString()]]; // Initialize if it's a new review

            productReviews.set(event.pubkey, updatedReview);
          }
        },
        oneose() {
          productReviewsMap.forEach((merchantProducts, merchantPubkey) => {
            merchantProducts.forEach((productReviews, productDTag) => {
              productReviews.forEach((review, reviewerPubkey) => {
                // Filter out the created_at entries
                const cleanedReview = review.filter(
                  (item) => item[0] !== "created_at",
                );
                if (cleanedReview.length > 0) {
                  productReviews.set(reviewerPubkey, cleanedReview);
                }
              });
            });
          });

          editReviewsContext(merchantScoresMap, productReviewsMap, false);
          h.close();
          resolve({ merchantScoresMap, productReviewsMap });
        },
      });
    } catch (error) {
      console.log("failed to fetch reviews: ", error);
      reject(error);
    }
  });
};

export const fetchAllFollows = async (
  relays: string[],
  editFollowsContext: (
    followList: string[],
    firstDegreeFollowsLength: number,
    isLoading: boolean,
  ) => void,
): Promise<{
  followList: string[];
}> => {
  return new Promise(async function (resolve, reject) {
    const wot = getLocalStorageData().wot;
    try {
      const pool = new SimplePool();

      let followsArrayFromRelay: string[] = [];
      const followsSet: Set<string> = new Set();
      let firstDegreeFollowsLength = 0;
      let secondDegreeFollowsArrayFromRelay: string[] = [];

      const firstFollowfilter: Filter = {
        kinds: [3],
        authors: [
          getLocalStorageData().userPubkey
            ? getLocalStorageData().userPubkey
            : "d36e8083fa7b36daee646cb8b3f99feaa3d89e5a396508741f003e21ac0b6bec",
        ],
      };

      const fetchSecondDegreeFollows = (authors: string[]) => {
        const secondFollowFilter: Filter = {
          kinds: [3],
          authors,
        };
        let second = pool.subscribeMany(relays, [secondFollowFilter], {
          onevent(followEvent) {
            const validFollowTags = followEvent.tags
              .map((tag) => tag[1])
              .filter(
                (pubkey) => isHexString(pubkey) && !followsSet.has(pubkey),
              );
            secondDegreeFollowsArrayFromRelay.push(...validFollowTags);
          },
          oneose: async () => {
            second.close();
            // Filter second degree follows based on count
            const pubkeyCount: Map<string, number> = new Map();
            secondDegreeFollowsArrayFromRelay.forEach((pubkey) => {
              pubkeyCount.set(pubkey, (pubkeyCount.get(pubkey) || 0) + 1);
            });
            secondDegreeFollowsArrayFromRelay =
              secondDegreeFollowsArrayFromRelay.filter(
                (pubkey) => (pubkeyCount.get(pubkey) || 0) >= wot,
              );
            // Concatenate arrays ensuring uniqueness
            followsArrayFromRelay = Array.from(
              new Set(
                followsArrayFromRelay.concat(secondDegreeFollowsArrayFromRelay),
              ),
            );
            await returnCall(
              relays,
              followsArrayFromRelay,
              followsSet,
              firstDegreeFollowsLength,
            );
          },
        });
      };

      let first = pool.subscribeMany(relays, [firstFollowfilter], {
        onevent(event) {
          const validTags = event.tags
            .map((tag) => tag[1])
            .filter((pubkey) => isHexString(pubkey) && !followsSet.has(pubkey));
          validTags.forEach((pubkey) => followsSet.add(pubkey));
          followsArrayFromRelay.push(...validTags);
          firstDegreeFollowsLength = followsArrayFromRelay.length;
          // Fetch second-degree follows
          fetchSecondDegreeFollows(followsArrayFromRelay);
        },
        oneose() {
          first.close();
        },
      });

      const returnCall = async (
        relays: string[],
        followsArray: string[],
        followsSet: Set<string>,
        firstDegreeFollowsLength: number,
      ) => {
        // If followsArrayFromRelay is still empty, add the default value
        if (followsArray?.length === 0) {
          const firstFollowfilter: Filter = {
            kinds: [3],
            authors: [
              "d36e8083fa7b36daee646cb8b3f99feaa3d89e5a396508741f003e21ac0b6bec",
            ],
          };

          const fetchSecondDegreeFollows = (authors: string[]) => {
            const secondFollowFilter: Filter = {
              kinds: [3],
              authors,
            };

            let secondDegreeFollowsArray: string[] = [];

            let second = pool.subscribeMany(relays, [secondFollowFilter], {
              onevent(followEvent) {
                const validFollowTags = followEvent.tags
                  .map((tag) => tag[1])
                  .filter(
                    (pubkey) => isHexString(pubkey) && !followsSet.has(pubkey),
                  );
                secondDegreeFollowsArray.push(...validFollowTags);
              },
              oneose() {
                second.close();
                const pubkeyCount: Map<string, number> = new Map();
                secondDegreeFollowsArray.forEach((pubkey) => {
                  pubkeyCount.set(pubkey, (pubkeyCount.get(pubkey) || 0) + 1);
                });
                secondDegreeFollowsArray = secondDegreeFollowsArray.filter(
                  (pubkey) => (pubkeyCount.get(pubkey) || 0) >= wot,
                );

                // Concatenate arrays ensuring uniqueness
                followsArray = Array.from(
                  new Set(followsArray.concat(secondDegreeFollowsArray)),
                );
              },
            });
          };

          let first = pool.subscribeMany(relays, [firstFollowfilter], {
            onevent(event) {
              const validTags = event.tags
                .map((tag) => tag[1])
                .filter(
                  (pubkey) => isHexString(pubkey) && !followsSet.has(pubkey),
                );
              validTags.forEach((pubkey) => followsSet.add(pubkey));
              followsArray.push(...validTags);

              firstDegreeFollowsLength = followsArray.length;
              fetchSecondDegreeFollows(followsArray);
            },
            oneose() {
              first.close();
            },
          });
        }
        resolve({
          followList: followsArray,
        });
        editFollowsContext(followsArray, firstDegreeFollowsLength, false);
      };
    } catch (error) {
      console.log("Failed to fetch follow list: ", error);
      reject(error);
    }
  });
};

export const fetchAllRelays = async (
  relays: string[],
  editRelaysContext: (
    relayList: string[],
    readRelayList: string[],
    writeRelayList: string[],
    isLoading: boolean,
  ) => void,
): Promise<{
  relayList: string[];
  readRelayList: string[];
  writeRelayList: string[];
}> => {
  return new Promise(async function (resolve, reject) {
    try {
      const pool = new SimplePool();

      let relayList: string[] = [];
      const relaySet: Set<string> = new Set();
      let readRelayList: string[] = [];
      const readRelaySet: Set<string> = new Set();
      let writeRelayList: string[] = [];
      const writeRelaySet: Set<string> = new Set();

      const relayfilter: Filter = {
        kinds: [10002],
        authors: [getLocalStorageData().userPubkey],
      };

      let h = pool.subscribeMany(relays, [relayfilter], {
        onevent(event) {
          const validRelays = event.tags.filter(
            (tag) => tag[0] === "r" && !tag[2],
          );

          const validReadRelays = event.tags.filter(
            (tag) => tag[0] === "r" && tag[2] === "read",
          );

          const validWriteRelays = event.tags.filter(
            (tag) => tag[0] === "r" && tag[2] === "write",
          );

          validRelays.forEach((tag) => relaySet.add(tag[1]));
          relayList.push(...validRelays.map((tag) => tag[1]));

          validReadRelays.forEach((tag) => readRelaySet.add(tag[1]));
          readRelayList.push(...validReadRelays.map((tag) => tag[1]));

          validWriteRelays.forEach((tag) => writeRelaySet.add(tag[1]));
          writeRelayList.push(...validWriteRelays.map((tag) => tag[1]));
        },
        oneose: async () => {
          h.close();
          await returnCall(relayList, readRelayList, writeRelayList);
        },
      });
      const returnCall = async (
        relayList: string[],
        readRelayList: string[],
        writeRelayList: string[],
      ) => {
        resolve({
          relayList: relayList,
          readRelayList: readRelayList,
          writeRelayList: writeRelayList,
        });
        editRelaysContext(relayList, readRelayList, writeRelayList, false);
      };
    } catch (error) {
      console.log("failed to fetch follow list: ", error);
      reject(error);
    }
  });
};

export const fetchCashuWallet = async (
  relays: string[],
  editCashuWalletContext: (
    walletEvents: NostrEvent,
    proofEvents: any[],
    cashuWalletRelays: string[],
    cashuMints: string[],
    cashuProofs: Proof[],
    isLoading: boolean,
  ) => void,
  passphrase?: string,
): Promise<{
  mostRecentWalletEvent: NostrEvent;
  proofEvents: any[];
  cashuWalletRelays: string[];
  cashuMints: string[];
  cashuProofs: Proof[];
}> => {
  return new Promise(async function (resolve, reject) {
    const { userPubkey, signInMethod, tokens } = getLocalStorageData();
    try {
      let mostRecentWalletEvent: NostrEvent[] = [];
      let proofEvents: any[] = [];

      let cashuRelays: string[] = [];
      const cashuRelaySet: Set<string> = new Set();

      let cashuMints: string[] = [];
      let cashuMintSet: Set<string> = new Set();

      let cashuProofs: Proof[] = [];
      let incomingSpendingHistory: [][] = [];

      const pool = new SimplePool();

      const cashuWalletFilter: Filter = {
        kinds: [37375],
        authors: [userPubkey],
      };

      const handleHSubscription = new Promise<void>((resolveH) => {
        let h = pool.subscribeMany(relays, [cashuWalletFilter], {
          onevent: async (event) => {
            if (
              mostRecentWalletEvent.length === 0 ||
              event.created_at > mostRecentWalletEvent[0].created_at
            ) {
              mostRecentWalletEvent = [event];
            }
          },
          oneose() {
            h.close();
            if (mostRecentWalletEvent.length > 0) {
              const relayList = mostRecentWalletEvent[0].tags.filter(
                (tag: string[]) => tag[0] === "relay",
              );
              relayList.forEach((tag) => cashuRelaySet.add(tag[1]));
              cashuRelays.push(...relayList.map((tag: string[]) => tag[1]));
              const mints = mostRecentWalletEvent[0].tags.filter(
                (tag: string[]) => tag[0] === "mint",
              );
              mints.forEach((tag) => cashuMintSet.add(tag[1]));
              cashuMints.push(...mints.map((tag: string[]) => tag[1]));
            }
            resolveH();
          },
        });
      });

      const cashuProofFilter: Filter = {
        kinds: [7375, 7376],
        authors: [userPubkey],
      };

      const handleWSubscription = new Promise<void>((resolveW) => {
        let w = pool.subscribeMany(
          cashuRelays.length !== 0 ? cashuRelays : relays,
          [cashuProofFilter],
          {
            onevent: async (event) => {
              try {
                let cashuWalletEventContent;
                if (signInMethod === "extension") {
                  let eventContent = await window.nostr.nip44.decrypt(
                    userPubkey,
                    event.content,
                  );
                  if (eventContent) {
                    cashuWalletEventContent = JSON.parse(eventContent);
                  }
                } else if (signInMethod === "nsec") {
                  if (!passphrase) throw new Error("Passphrase is required");
                  let senderPrivkey = getPrivKeyWithPassphrase(
                    passphrase,
                  ) as Uint8Array;
                  const conversationKey = nip44.getConversationKey(
                    senderPrivkey,
                    getLocalStorageData().userPubkey,
                  );
                  let eventContent = nip44.decrypt(
                    event.content,
                    conversationKey,
                  );
                  cashuWalletEventContent = JSON.parse(eventContent);
                } else if (signInMethod === "amber") {
                  const amberSignerUrl = `nostrsigner:${event.content}?pubKey=${
                    getLocalStorageData().userPubkey
                  }&compressionType=none&returnType=signature&type=nip44_decrypt`;

                  await navigator.clipboard.writeText("");

                  window.open(amberSignerUrl, "_blank");

                  const readClipboard = (): Promise<string> => {
                    return new Promise((resolve, reject) => {
                      const checkClipboard = async () => {
                        try {
                          if (!document.hasFocus()) {
                            console.log(
                              "Document not focused, waiting for focus...",
                            );
                            return;
                          }

                          const clipboardContent =
                            await navigator.clipboard.readText();

                          if (clipboardContent && clipboardContent !== "") {
                            clearInterval(intervalId);
                            let eventContent = clipboardContent;

                            let parsedContent = JSON.parse(eventContent);

                            resolve(parsedContent);
                          } else {
                            console.log("Waiting for new clipboard content...");
                          }
                        } catch (error) {
                          console.error("Error reading clipboard:", error);
                          reject(error);
                        }
                      };

                      checkClipboard();
                      const intervalId = setInterval(checkClipboard, 1000);

                      setTimeout(() => {
                        clearInterval(intervalId);
                        console.log("Amber decryption timeout");
                        alert("Amber decryption timed out. Please try again.");
                      }, 60000);
                    });
                  };

                  try {
                    cashuWalletEventContent = await readClipboard();
                  } catch (error) {
                    console.error("Error reading clipboard:", error);
                    alert("Amber decryption failed. Please try again.");
                  }
                }
                if (
                  event.kind === 7375 &&
                  cashuWalletEventContent.mint &&
                  cashuWalletEventContent.proofs
                ) {
                  proofEvents.push({
                    id: event.id,
                    proofs: cashuWalletEventContent.proofs,
                  });
                  let wallet = new CashuWallet(
                    new CashuMint(cashuWalletEventContent?.mint),
                  );
                  let spentProofs = await wallet?.checkProofsSpent(
                    cashuWalletEventContent?.proofs,
                  );
                  if (
                    spentProofs &&
                    spentProofs.length > 0 &&
                    JSON.stringify(spentProofs) ===
                      JSON.stringify(cashuWalletEventContent?.proofs)
                  ) {
                    await DeleteEvent([event.id], passphrase);
                  } else if (cashuWalletEventContent.proofs) {
                    let allProofs = [
                      ...tokens,
                      ...cashuWalletEventContent?.proofs,
                      ...cashuProofs,
                    ];
                    cashuProofs = getUniqueProofs(allProofs);
                  }
                } else if (event.kind === 7376 && cashuWalletEventContent) {
                  incomingSpendingHistory.push(cashuWalletEventContent);
                }
              } catch (decryptionError) {
                console.error(
                  "Error decrypting or parsing content:",
                  decryptionError,
                );
              }
            },
            oneose() {
              w.close();
              cashuMints.forEach(async (mint) => {
                try {
                  let wallet = new CashuWallet(new CashuMint(mint));
                  if (cashuProofs.length > 0) {
                    let spentProofs =
                      await wallet?.checkProofsSpent(cashuProofs);
                    if (spentProofs.length > 0) {
                      cashuProofs = cashuProofs.filter(
                        (proof) => !spentProofs.includes(proof),
                      );
                    }
                  }

                  let outProofIds = incomingSpendingHistory
                    .filter((eventTags) =>
                      eventTags.some(
                        (tag) => tag[0] === "direction" && tag[1] === "out",
                      ),
                    )
                    .map((eventTags) => {
                      const destroyedTag = eventTags.find(
                        (tag) => tag[0] === "e" && tag[3] === "destroyed",
                      );
                      return destroyedTag ? destroyedTag[1] : "";
                    })
                    .filter((eventId) => eventId !== "");

                  let destroyedProofsArray = proofEvents
                    .filter((event) => outProofIds.includes(event.id))
                    .map((event) => event.proofs);

                  cashuProofs = cashuProofs.filter(
                    (cashuProof) =>
                      !destroyedProofsArray.some(
                        (destroyedProof) =>
                          JSON.stringify(destroyedProof) ===
                          JSON.stringify(cashuProof),
                      ),
                  );

                  let inProofIds = incomingSpendingHistory
                    .filter((eventTags) =>
                      eventTags.some(
                        (tag) => tag[0] === "direction" && tag[1] === "out",
                      ),
                    )
                    .map((eventTags) => {
                      const createdTag = eventTags.find(
                        (tag) => tag[0] === "e" && tag[3] === "created",
                      );
                      return createdTag ? createdTag[1] : "";
                    })
                    .filter((eventId) => eventId !== "");

                  let proofIdsToAddBack = inProofIds.filter(
                    (id) => !outProofIds.includes(id),
                  );

                  let arrayOfProofsToAddBack = proofEvents
                    .filter((event) => proofIdsToAddBack.includes(event.id))
                    .map((event) => event.proofs);

                  const proofExists = (proof: Proof, proofArray: Proof[]) =>
                    proofArray.some(
                      (existingProof) =>
                        JSON.stringify(existingProof) === JSON.stringify(proof),
                    );

                  arrayOfProofsToAddBack.forEach((proofsToAddBack) => {
                    proofsToAddBack.forEach((proof: Proof) => {
                      if (!proofExists(proof, cashuProofs)) {
                        cashuProofs.push(proof);
                      }
                    });
                  });

                  if (outProofIds.length > 0) {
                    await DeleteEvent(outProofIds, passphrase);
                  }
                } catch (error) {
                  console.log("Error checking spent proofs: ", error);
                }
              });
              resolveW();
            },
          },
        );
      });

      await Promise.all([handleHSubscription, handleWSubscription]);

      const returnCall = async (
        mostRecentWalletEvent: NostrEvent[],
        proofEvents: any[],
        cashuWalletRelays: string[],
        cashuMints: string[],
        cashuProofs: Proof[],
      ) => {
        resolve({
          mostRecentWalletEvent: mostRecentWalletEvent[0],
          proofEvents: proofEvents,
          cashuWalletRelays: cashuRelays,
          cashuMints: cashuMints,
          cashuProofs: cashuProofs,
        });
        editCashuWalletContext(
          mostRecentWalletEvent[0],
          proofEvents,
          cashuWalletRelays,
          cashuMints,
          cashuProofs,
          false,
        );
      };
      await returnCall(
        mostRecentWalletEvent,
        proofEvents,
        cashuRelays,
        cashuMints,
        cashuProofs,
      );
    } catch (error) {
      console.log("failed to fetch Cashu wallet: ", error);
      reject(error);
    }
  });
};
