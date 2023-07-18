import { BigNumber } from "bignumber.js";
import {
  NotEnoughBalance,
  RecipientRequired,
  InvalidAddress,
  InvalidAddressBecauseDestinationIsAlsoSource,
  AmountRequired,
  NotEnoughBalanceBecauseDestinationNotCreated,
  FeeNotLoaded,
} from "@ledgerhq/errors";
import { formatCurrencyUnit } from "@ledgerhq/coin-framework/currencies/index";
import type { PolkadotAccount, Transaction, TransactionStatus } from "./types";
import {
  PolkadotUnauthorizedOperation,
  PolkadotElectionClosed,
  PolkadotNotValidator,
  PolkadotNoUnlockedBalance,
  PolkadotNoNominations,
  PolkadotAllFundsWarning,
  PolkadotBondMinimumAmount,
  PolkadotBondMinimumAmountWarning,
  PolkadotMaxUnbonding,
  PolkadotValidatorsRequired,
  PolkadotDoMaxSendInstead,
} from "./errors";
import {
  EXISTENTIAL_DEPOSIT,
  FEES_SAFETY_BUFFER,
  isFirstBond,
  isController,
  isStash,
  hasLockedBalance,
  hasMaxUnlockings,
  calculateAmount,
  getMinimumAmountToBond,
  getMinimumBalance,
} from "./logic";
import { isValidAddress } from "./address";
import { getCurrentPolkadotPreloadData } from "./preload";
import { loadPolkadotCrypto } from "./polkadot-crypto";
import { PolkadotAPI } from "./api";

// Should try to refacto
export const getSendTransactionStatus = async (
  polkadotAPI: PolkadotAPI,
  a: PolkadotAccount,
  t: Transaction,
  amount: BigNumber,
): Promise<TransactionStatus> => {
  const errors: any = {};
  const warnings: any = {};

  if (!t.fees) {
    errors.fees = new FeeNotLoaded();
  }

  if (!t.recipient) {
    errors.recipient = new RecipientRequired("");
  } else if (a.freshAddress === t.recipient) {
    errors.recipient = new InvalidAddressBecauseDestinationIsAlsoSource();
  } else if (!isValidAddress(t.recipient)) {
    errors.recipient = new InvalidAddress("", {
      currencyName: a.currency.name,
    });
  }

  const estimatedFees = t.fees || new BigNumber(0);
  const totalSpent = amount.plus(estimatedFees);

  const minimumBalanceExistential = getMinimumBalance(a);
  const leftover = a.spendableBalance.minus(totalSpent);

  if (minimumBalanceExistential.gt(0) && leftover.lt(minimumBalanceExistential) && leftover.gt(0)) {
    errors.amount = new PolkadotDoMaxSendInstead("", {
      minimumBalance: formatCurrencyUnit(a.currency.units[0], EXISTENTIAL_DEPOSIT, {
        showCode: true,
      }),
    });
  } else if (!t.useAllAmount && totalSpent.gt(a.spendableBalance)) {
    errors.amount = new NotEnoughBalance();
  }

  if (
    !errors.amount &&
    a.polkadotResources?.lockedBalance.gt(0) &&
    (t.useAllAmount || a.spendableBalance.minus(totalSpent).lt(FEES_SAFETY_BUFFER))
  ) {
    warnings.amount = new PolkadotAllFundsWarning();
  }

  if (
    !errors.recipient &&
    amount.lt(EXISTENTIAL_DEPOSIT) &&
    (await polkadotAPI.isNewAccount(t.recipient))
  ) {
    errors.amount = new NotEnoughBalanceBecauseDestinationNotCreated("", {
      minimalAmount: formatCurrencyUnit(a.currency.units[0], EXISTENTIAL_DEPOSIT, {
        showCode: true,
      }),
    });
  }

  return {
    errors,
    warnings,
    estimatedFees,
    amount: amount.lt(0) ? new BigNumber(0) : amount,
    totalSpent,
  };
};

const getTransactionStatus =
  (polkadotAPI: PolkadotAPI) => async (a: PolkadotAccount, t: Transaction) => {
    await loadPolkadotCrypto();

    const errors: {
      staking?: Error;
      amount?: Error;
      recipient?: Error;
      unbondings?: Error;
    } = {};
    const warnings: {
      amount?: Error;
    } = {};
    const preloaded = getCurrentPolkadotPreloadData();
    const { staking, validators } = preloaded;
    const minimumBondBalance = new BigNumber(preloaded.minimumBondBalance);
    const amount = calculateAmount({
      a,
      t,
    });

    if (amount.lte(0) && !t.useAllAmount && ["bond", "unbond", "rebond", "send"].includes(t.mode)) {
      return {
        errors: {
          amount: new AmountRequired(),
        },
        warnings,
        estimatedFees: t.fees || new BigNumber(0),
        amount: new BigNumber(0),
        totalSpent: t.fees || new BigNumber(0),
      };
    }

    if (t.mode === "send") {
      return getSendTransactionStatus(polkadotAPI, a, t, amount);
    }

    if (
      (staking && !staking.electionClosed) || // Preloaded
      (!staking && (await !polkadotAPI.isElectionClosed())) // Fallback
    ) {
      errors.staking = new PolkadotElectionClosed();
    }

    const unlockingBalance = a.polkadotResources?.unlockingBalance || new BigNumber(0);
    const unlockedBalance = a.polkadotResources?.unlockedBalance || new BigNumber(0);
    const currentBonded =
      a.polkadotResources?.lockedBalance.minus(unlockingBalance) || new BigNumber(0);

    const minimumAmountToBond = getMinimumAmountToBond(a, minimumBondBalance);

    switch (t.mode) {
      case "bond":
        if (amount.lt(minimumAmountToBond)) {
          errors.amount = new PolkadotBondMinimumAmount("", {
            minimumBondAmount: formatCurrencyUnit(a.currency.units[0], minimumAmountToBond, {
              showCode: true,
            }),
          });
        }

        if (isFirstBond(a)) {
          // Not a stash yet -> bond method sets the controller
          if (!t.recipient) {
            errors.recipient = new RecipientRequired("");
          } else if (!isValidAddress(t.recipient)) {
            errors.recipient = new InvalidAddress("", {
              currencyName: a.currency.name,
            });
          } else if (await polkadotAPI.isControllerAddress(t.recipient)) {
            errors.recipient = new PolkadotUnauthorizedOperation(
              "Recipient is already a controller",
            );
          }
        }

        break;

      case "unbond":
        if (!isController(a) || !hasLockedBalance(a)) {
          errors.staking = new PolkadotUnauthorizedOperation();
        }

        if (hasMaxUnlockings(a)) {
          errors.unbondings = new PolkadotMaxUnbonding();
        }

        if (amount.gt(currentBonded.minus(minimumBondBalance)) && amount.lt(currentBonded)) {
          warnings.amount = new PolkadotBondMinimumAmountWarning("", {
            minimumBondBalance: formatCurrencyUnit(a.currency.units[0], minimumBondBalance, {
              showCode: true,
            }),
          });
        } else if (amount.gt(currentBonded)) {
          errors.amount = new NotEnoughBalance();
        }

        break;

      case "rebond":
        if (!isController(a)) {
          errors.staking = new PolkadotUnauthorizedOperation();
        }

        if (amount.gt(unlockingBalance)) {
          errors.amount = new NotEnoughBalance();
        } else if (amount.lt(minimumAmountToBond)) {
          warnings.amount = new PolkadotBondMinimumAmountWarning("", {
            minimumBondBalance: formatCurrencyUnit(a.currency.units[0], minimumBondBalance, {
              showCode: true,
            }),
          });
        }

        break;

      case "withdrawUnbonded":
        if (!isController(a)) {
          errors.staking = new PolkadotUnauthorizedOperation();
        }

        if (unlockedBalance.lte(0)) {
          errors.amount = new PolkadotNoUnlockedBalance();
        }

        break;

      case "nominate":
        if (!isController(a)) {
          errors.staking = new PolkadotUnauthorizedOperation();
        } else if (!t.validators || t.validators?.length === 0) {
          errors.staking = new PolkadotValidatorsRequired();
        } else {
          if (validators && validators.length) {
            // Validate directly with preloaded data
            const notValidators = t.validators?.filter(
              address => !validators.find(v => v.address === address),
            );

            if (notValidators && notValidators.length) {
              errors.staking = new PolkadotNotValidator(undefined, {
                validators: notValidators,
              });
            }
          } else {
            // Fallback with api call
            const notValidators = await polkadotAPI.verifyValidatorAddresses(t.validators || []);

            if (notValidators.length) {
              errors.staking = new PolkadotNotValidator(undefined, {
                validators: notValidators,
              });
              break;
            }
          }
        }

        break;

      case "chill":
        if (!isController(a)) {
          errors.staking = new PolkadotUnauthorizedOperation();
        } else if (!a.polkadotResources?.nominations) {
          errors.staking = new PolkadotNoNominations();
        }

        break;

      case "setController":
        if (!isStash(a)) {
          errors.staking = new PolkadotUnauthorizedOperation();
        }
        break;
    }

    const estimatedFees = t.fees || new BigNumber(0);
    const totalSpent = t.mode === "bond" ? amount.plus(estimatedFees) : estimatedFees;

    if (t.mode === "bond" && a.spendableBalance.minus(totalSpent).lt(FEES_SAFETY_BUFFER)) {
      errors.amount = new NotEnoughBalance();
    }

    if (totalSpent.gt(a.spendableBalance)) {
      errors.amount = new NotEnoughBalance();
    }

    return {
      errors,
      warnings,
      estimatedFees,
      amount: amount.lt(0) ? new BigNumber(0) : amount,
      totalSpent,
    };
  };

export default getTransactionStatus;
