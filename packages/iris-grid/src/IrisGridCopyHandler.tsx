import React, { Component } from 'react';
import classNames from 'classnames';
import { Button, FadeTransition, LoadingSpinner } from '@deephaven/components';
import {
  GridRange,
  GridUtils,
  ModelSizeMap,
  MoveOperation,
} from '@deephaven/grid';
import {
  CancelablePromise,
  CanceledPromiseError,
  copyToClipboard,
  PromiseUtils,
} from '@deephaven/utils';
import Log from '@deephaven/log';
import type { dh } from '@deephaven/jsapi-types';
import IrisGridUtils from './IrisGridUtils';
import IrisGridBottomBar from './IrisGridBottomBar';
import './IrisGridCopyHandler.scss';
import IrisGridModel from './IrisGridModel';

const log = Log.module('IrisGridCopyHandler');

type Values<T> = T[keyof T];

type ButtonStateType = Values<typeof IrisGridCopyHandler.BUTTON_STATES>;

type CommonCopyOperation = {
  movedColumns: readonly MoveOperation[];
  error?: string;
};

export type CopyRangesOperation = CommonCopyOperation & {
  ranges: readonly GridRange[];
  includeHeaders: boolean;
  formatValues?: boolean;
  userColumnWidths: ModelSizeMap;
};

export type CopyHeaderOperation = CommonCopyOperation & {
  columnIndex: number;
  columnDepth: number;
};

export type CopyOperation = CopyRangesOperation | CopyHeaderOperation;

function isCopyRangesOperation(
  copyOperation: CopyOperation
): copyOperation is CopyRangesOperation {
  return (copyOperation as CopyRangesOperation).ranges != null;
}

function isCopyHeaderOperation(
  copyOperation: CopyOperation
): copyOperation is CopyHeaderOperation {
  return (copyOperation as CopyHeaderOperation).columnIndex != null;
}

interface IrisGridCopyHandlerProps {
  model: IrisGridModel;
  copyOperation: CopyOperation;
  onEntering: () => void;
  onEntered: () => void;
  onExiting: () => void;
  onExited: () => void;
}

interface IrisGridCopyHandlerState {
  error?: string;
  copyState: string;
  buttonState: string;
  isShown: boolean;
  rowCount: number;
}
/**
 * Component for handling copying of data from the Iris Grid.
 * - Prompts if necessary (large amount of rows copied)
 * - Tries to async copy, falls back to showing a "Click to Copy" button if that fails
 */
class IrisGridCopyHandler extends Component<
  IrisGridCopyHandlerProps,
  IrisGridCopyHandlerState
> {
  static NO_PROMPT_THRESHOLD = 10000;

  static HIDE_TIMEOUT = 3000;

  /**
   * Different states for the current copy operation
   */
  static COPY_STATES = {
    // No copy operation in progress
    IDLE: 'IDLE',

    // Large copy operation, confirmation required
    CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',

    // Fetch is currently in progress for copy ranges operation
    FETCH_RANGES_IN_PROGRESS: 'FETCH_RANGES_IN_PROGRESS',

    // Fetch is currently in progress for copy header operation
    FETCH_HEADER_IN_PROGRESS: 'FETCH_HEADER_IN_PROGRESS',

    // There was an error fetching the data
    FETCH_ERROR: 'FETCH_ERROR',

    // Click is required to copy
    CLICK_REQUIRED: 'CLICK_REQUIRED',

    // The copy operation is completed and successfully copied to the clipboard
    DONE: 'DONE',
  };

  static BUTTON_STATES = {
    COPY: 'COPY',
    FETCH_IN_PROGRESS: 'FETCH_IN_PROGRESS',
    CLICK_TO_COPY: 'CLICK_TO_COPY',
    RETRY: 'RETRY',
  };

  static defaultProps = {
    copyOperation: null,
    onEntering: (): void => undefined,
    onEntered: (): void => undefined,
    onExiting: (): void => undefined,
    onExited: (): void => undefined,
  };

  static getStatusMessageText(copyState: string, rowCount: number): string {
    switch (copyState) {
      case IrisGridCopyHandler.COPY_STATES.CONFIRMATION_REQUIRED:
        return `Are you sure you want to copy ${rowCount.toLocaleString()} rows to your clipboard?`;
      case IrisGridCopyHandler.COPY_STATES.CLICK_REQUIRED:
        return `Fetched ${rowCount.toLocaleString()} rows!`;
      case IrisGridCopyHandler.COPY_STATES.FETCH_ERROR:
        return 'Unable to copy data.';
      case IrisGridCopyHandler.COPY_STATES.FETCH_RANGES_IN_PROGRESS:
        return `Fetching ${rowCount.toLocaleString()} rows for clipboard...`;
      case IrisGridCopyHandler.COPY_STATES.FETCH_HEADER_IN_PROGRESS:
        return 'Fetching header for clipboard...';
      case IrisGridCopyHandler.COPY_STATES.DONE:
        return 'Copied to Clipboard!';
      default:
        return '';
    }
  }

  static getCopyButtonText(buttonState: ButtonStateType): string {
    switch (buttonState) {
      case IrisGridCopyHandler.BUTTON_STATES.FETCH_IN_PROGRESS:
        return 'Fetching';
      case IrisGridCopyHandler.BUTTON_STATES.CLICK_TO_COPY:
        return 'Click to Copy';
      case IrisGridCopyHandler.BUTTON_STATES.RETRY:
        return 'Retry';
      default:
        return 'Copy';
    }
  }

  constructor(props: IrisGridCopyHandlerProps) {
    super(props);

    this.handleBackgroundClick = this.handleBackgroundClick.bind(this);
    this.handleCancelClick = this.handleCancelClick.bind(this);
    this.handleCopyClick = this.handleCopyClick.bind(this);
    this.handleHideTimeout = this.handleHideTimeout.bind(this);

    this.state = {
      error: undefined,
      copyState: IrisGridCopyHandler.COPY_STATES.IDLE,
      buttonState: IrisGridCopyHandler.BUTTON_STATES.COPY,
      isShown: false,
      rowCount: 0,
    };
  }

  componentDidMount(): void {
    const { copyOperation } = this.props;
    if (copyOperation != null) {
      this.startCopy();
    }
  }

  componentDidUpdate(prevProps: IrisGridCopyHandlerProps): void {
    const { copyOperation } = this.props;
    if (prevProps.copyOperation !== copyOperation) {
      this.startCopy();
    }
  }

  componentWillUnmount(): void {
    this.stopCopy();
  }

  textData?: string;

  hideTimer?: ReturnType<typeof setTimeout>;

  fetchPromise?: CancelablePromise<string>;

  startCopy(): void {
    log.debug2('startCopy');

    this.stopCopy();

    const { copyOperation } = this.props;
    if (copyOperation == null) {
      log.debug2('No copy operation set, cancelling out');
      this.setState({ isShown: false });
      return;
    }

    const { error } = copyOperation;
    if (error != null) {
      log.debug('Showing copy error', error);
      this.setState({
        isShown: true,
        copyState: IrisGridCopyHandler.COPY_STATES.DONE,
        error,
      });
      this.startHideTimer();
      return;
    }

    this.setState({ isShown: true, error: undefined });

    if (isCopyRangesOperation(copyOperation)) {
      const { ranges } = copyOperation;
      const rowCount = GridRange.rowCount(ranges);
      this.setState({ rowCount });

      if (rowCount > IrisGridCopyHandler.NO_PROMPT_THRESHOLD) {
        this.setState({
          buttonState: IrisGridCopyHandler.BUTTON_STATES.COPY,
          copyState: IrisGridCopyHandler.COPY_STATES.CONFIRMATION_REQUIRED,
        });
        return;
      }
    }

    this.startFetch();
  }

  stopCopy(): void {
    this.textData = undefined;
    this.stopFetch();
    this.stopHideTimer();
  }

  handleBackgroundClick(): void {
    log.debug2('handleBackgroundClick');

    const { copyState } = this.state;
    if (copyState === IrisGridCopyHandler.COPY_STATES.DONE) {
      this.setState({ isShown: false });
    }
  }

  handleCancelClick(): void {
    log.debug2('handleCancelClick');

    this.stopFetch();
    this.setState({ isShown: false });
  }

  async handleCopyClick(): Promise<void> {
    log.debug2('handleCopyClick');

    if (this.textData != null) {
      try {
        await this.copyText(this.textData);
        this.showCopyDone();
      } catch (e) {
        log.error('Error copying text', e);
        this.setState({
          error: 'Unable to copy. Verify your browser permissions.',
        });
      }
    } else {
      this.startFetch();
    }
  }

  handleHideTimeout(): void {
    log.debug2('handleHideTimeout');

    this.stopHideTimer();

    this.setState({ isShown: false });
  }

  async copyText(text: string): Promise<void> {
    log.debug2('copyText', text);

    this.textData = text;

    await copyToClipboard(text);
  }

  showCopyDone(): void {
    this.setState({ copyState: IrisGridCopyHandler.COPY_STATES.DONE });
    this.startHideTimer();
  }

  async startFetch(): Promise<void> {
    this.stopFetch();

    const { model, copyOperation } = this.props;

    if (isCopyHeaderOperation(copyOperation)) {
      const { columnIndex, columnDepth, movedColumns } = copyOperation;
      log.debug('startFetch copyHeader', columnIndex, columnDepth);

      this.setState({
        buttonState: IrisGridCopyHandler.BUTTON_STATES.FETCH_IN_PROGRESS,
        copyState: IrisGridCopyHandler.COPY_STATES.FETCH_HEADER_IN_PROGRESS,
      });

      const modelIndex = GridUtils.getModelIndex(columnIndex, movedColumns);
      const copyText = model.textForColumnHeader(modelIndex, columnDepth);
      if (copyText === undefined) {
        this.fetchPromise = undefined;
        this.setState({
          error: 'Invalid column header selected.',
          copyState: IrisGridCopyHandler.COPY_STATES.DONE,
        });
        return;
      }
      this.fetchPromise = PromiseUtils.makeCancelable(copyText);
    } else {
      const {
        ranges,
        includeHeaders,
        userColumnWidths,
        movedColumns,
        formatValues,
      } = copyOperation;
      log.debug('startFetch copyRanges', ranges);

      this.setState({
        buttonState: IrisGridCopyHandler.BUTTON_STATES.FETCH_IN_PROGRESS,
        copyState: IrisGridCopyHandler.COPY_STATES.FETCH_RANGES_IN_PROGRESS,
      });

      const hiddenColumns = IrisGridUtils.getHiddenColumns(userColumnWidths);
      let modelRanges = GridUtils.getModelRanges(ranges, movedColumns);
      if (hiddenColumns.length > 0) {
        const subtractRanges = hiddenColumns.map(GridRange.makeColumn);
        modelRanges = GridRange.subtractRangesFromRanges(
          modelRanges,
          subtractRanges
        );
      }

      // Remove the hidden columns from the snapshot
      const formatValue =
        formatValues != null && formatValues
          ? (value: unknown, column: dh.Column) =>
              model.displayString(value, column.type, column.name)
          : (value: unknown) => `${value}`;

      this.fetchPromise = PromiseUtils.makeCancelable(
        model.textSnapshot(modelRanges, includeHeaders, formatValue)
      );
    }

    try {
      const text = await this.fetchPromise;
      this.fetchPromise = undefined;
      try {
        await this.copyText(text);
        this.showCopyDone();
      } catch (e) {
        log.error('Error copying text', e);
        this.setState({
          buttonState: IrisGridCopyHandler.BUTTON_STATES.CLICK_TO_COPY,
          copyState: IrisGridCopyHandler.COPY_STATES.CLICK_REQUIRED,
        });
      }
    } catch (e) {
      if (e instanceof CanceledPromiseError) {
        log.debug('User cancelled copy.');
      } else {
        log.error('Error fetching contents', e);
        this.fetchPromise = undefined;
        this.setState({
          buttonState: IrisGridCopyHandler.BUTTON_STATES.RETRY,
          copyState: IrisGridCopyHandler.COPY_STATES.FETCH_ERROR,
        });
      }
    }
  }

  stopFetch(): void {
    if (this.fetchPromise) {
      log.debug2('stopFetch');
      this.fetchPromise.cancel();
      this.fetchPromise = undefined;
    }
  }

  startHideTimer(): void {
    this.stopHideTimer();

    this.hideTimer = setTimeout(
      this.handleHideTimeout,
      IrisGridCopyHandler.HIDE_TIMEOUT
    );
  }

  stopHideTimer(): void {
    if (this.hideTimer != null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    }
  }

  render(): JSX.Element {
    const { onEntering, onEntered, onExiting, onExited } = this.props;
    const { buttonState, copyState, isShown, rowCount, error } = this.state;

    const animation =
      copyState === IrisGridCopyHandler.COPY_STATES.DONE
        ? 'fade'
        : 'copy-slide-up';
    const copyButtonText = IrisGridCopyHandler.getCopyButtonText(buttonState);
    const statusMessageText =
      error ?? IrisGridCopyHandler.getStatusMessageText(copyState, rowCount);
    const isButtonContainerVisible =
      copyState !== IrisGridCopyHandler.COPY_STATES.DONE;
    const isFetching =
      buttonState === IrisGridCopyHandler.BUTTON_STATES.FETCH_IN_PROGRESS;
    const isDone = copyState === IrisGridCopyHandler.COPY_STATES.DONE;

    return (
      <IrisGridBottomBar
        animation={animation}
        isShown={isShown}
        className={classNames('iris-grid-copy-handler', {
          'copy-done': isDone,
        })}
        onClick={this.handleBackgroundClick}
        onEntering={onEntering}
        onEntered={onEntered}
        onExiting={onExiting}
        onExited={onExited}
      >
        <div className="status-message">
          <span>{statusMessageText}</span>
        </div>
        <FadeTransition
          in={isButtonContainerVisible}
          mountOnEnter
          unmountOnExit
        >
          <div className="buttons-container">
            <button
              type="button"
              className="btn btn-outline-secondary btn-cancel"
              onClick={this.handleCancelClick}
            >
              Cancel
            </button>
            <Button
              kind={isFetching ? 'tertiary' : 'primary'}
              className={classNames('btn-copy', {
                'btn-spinner': isFetching,
              })}
              onClick={this.handleCopyClick}
              disabled={isFetching}
            >
              {isFetching && (
                <LoadingSpinner className="loading-spinner-vertical-align" />
              )}
              {copyButtonText}
            </Button>
          </div>
        </FadeTransition>
      </IrisGridBottomBar>
    );
  }
}

export default IrisGridCopyHandler;
